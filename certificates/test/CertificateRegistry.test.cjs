// Tests LOCAUX (réseau Hardhat en mémoire). Aucun réseau public.
// Les 17 tests d'origine sont conservés (numéros 1 à 17) et ADAPTÉS à la v2 ; chaque adaptation est signalée « v2 : ».
// Les tests N1 à N7 couvrent les corrections du 10 novembre 2026.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const fs = require("fs");
const path = require("path");

const Kind = { ECOLE_PRO: 0, ENTREPRISE_FORMATRICE: 1, EMPLOYEUR: 2 };
const Doc = { CFC: 0, AFP: 1, ATTESTATION_STAGE: 2, CERTIFICAT_TRAVAIL: 3 };
const Reason = { NONE: 0, ERREUR_SAISIE: 1, REMPLACE: 2, FRAUDE: 3, AUTRE: 4 };
const EX = path.join(__dirname, "..", "examples");
const pdfHash = (f) => ethers.keccak256(fs.readFileSync(path.join(EX, f)));
const gasLog = {};

async function deploy() {
  const [admin, ecole, entreprise, employeur, inconnu, recruteur, autre] = await ethers.getSigners();
  const reg = await (await ethers.getContractFactory("CertificateRegistry")).deploy(admin.address);
  await reg.approveIssuer(ecole.address, "École professionnelle Exemple de Lausanne", Kind.ECOLE_PRO);
  await reg.approveIssuer(entreprise.address, "Atelier Démo Sàrl", Kind.ENTREPRISE_FORMATRICE);
  await reg.approveIssuer(employeur.address, "Exemple Transports SA", Kind.EMPLOYEUR);
  return { reg, admin, ecole, entreprise, employeur, inconnu, recruteur, autre };
}
const one = async (reg, h) => { const a = await reg.verify(h); expect(a.length).to.equal(1); return a[0]; };

describe("CertificateRegistry v2 (local)", function () {
  const hCfc = pdfHash("exemple-cfc-informaticien.pdf");
  const hStage = pdfHash("exemple-attestation-stage.pdf");
  const hTravail = pdfHash("exemple-certificat-travail.pdf");
  const hFalsifie = pdfHash("exemple-cfc-informaticien-FALSIFIE.pdf");

  describe("Tests d'origine (adaptés)", function () {
    it("1. chemin normal : une école émet un CFC, un recruteur sans rôle le vérifie", async () => {
      const { reg, ecole, recruteur } = await deploy();
      // v2 : plus de metadataURI dans issue() ni dans l'événement
      await expect(reg.connect(ecole).issue(hCfc, Doc.CFC)).to.emit(reg, "CertificateIssued").withArgs(hCfc, ecole.address, Doc.CFC);
      const v = await one(reg.connect(recruteur), hCfc);
      expect(v.issuer).to.equal(ecole.address);
      expect(v.issuerName).to.equal("École professionnelle Exemple de Lausanne");
      expect(v.issuerKind).to.equal(Kind.ECOLE_PRO);
      expect(v.issuerActive).to.equal(true);
      expect(v.docType).to.equal(Doc.CFC);
      expect(v.issuedAt).to.be.greaterThan(0n);
      expect(v.revoked).to.equal(false);
      expect(v.revokedAt).to.equal(0n);
      expect(v.revokeReason).to.equal(Reason.NONE);
      expect(v.issuedWhileDistrusted).to.equal(false);
    });

    it("2. stage et certificat de travail par une entreprise formatrice et un employeur", async () => {
      const { reg, entreprise, employeur } = await deploy();
      // v2 : le champ libre metadataURI n'existe plus (voir N2)
      await reg.connect(entreprise).issue(hStage, Doc.ATTESTATION_STAGE);
      await reg.connect(employeur).issue(hTravail, Doc.CERTIFICAT_TRAVAIL);
      expect((await one(reg, hStage)).docType).to.equal(Doc.ATTESTATION_STAGE);
      expect((await one(reg, hTravail)).issuerName).to.equal("Exemple Transports SA");
    });

    it("3. un émetteur non approuvé est refusé", async () => {
      const { reg, inconnu } = await deploy();
      await expect(reg.connect(inconnu).issue(hCfc, Doc.CFC)).to.be.revertedWithCustomError(reg, "IssuerUnknown").withArgs(inconnu.address);
    });

    it("4. seul l'admin approuve, renomme, suspend, met en pause, révoque en admin", async () => {
      const { reg, ecole, inconnu } = await deploy();
      const U = "AccessControlUnauthorizedAccount";
      await expect(reg.connect(inconnu).approveIssuer(inconnu.address, "Faux", Kind.ECOLE_PRO)).to.be.revertedWithCustomError(reg, U);
      await expect(reg.connect(ecole).suspendIssuer(ecole.address, 0)).to.be.revertedWithCustomError(reg, U);
      await expect(reg.connect(ecole).pause()).to.be.revertedWithCustomError(reg, U);
      await expect(reg.connect(ecole).renameIssuer(ecole.address, "X")).to.be.revertedWithCustomError(reg, U);
      await reg.connect(ecole).issue(hCfc, Doc.CFC);
      await expect(reg.connect(ecole).adminRevoke(hCfc, ecole.address, Reason.FRAUDE)).to.be.revertedWithCustomError(reg, U);
      await expect(reg.connect(ecole).adminUnrevoke(hCfc, ecole.address)).to.be.revertedWithCustomError(reg, U);
    });

    it("5. un employeur ne peut pas fabriquer un CFC ou une AFP", async () => {
      const { reg, employeur, entreprise, ecole } = await deploy();
      await expect(reg.connect(employeur).issue(hCfc, Doc.CFC)).to.be.revertedWithCustomError(reg, "TypeNotAllowedForIssuer").withArgs(Kind.EMPLOYEUR, Doc.CFC);
      await expect(reg.connect(entreprise).issue(hCfc, Doc.AFP)).to.be.revertedWithCustomError(reg, "TypeNotAllowedForIssuer");
      await expect(reg.connect(ecole).issue(hTravail, Doc.CERTIFICAT_TRAVAIL)).to.be.revertedWithCustomError(reg, "TypeNotAllowedForIssuer");
    });

    it("6. un émetteur ne peut pas émettre deux fois la même empreinte (v2 : un AUTRE émetteur le peut, et c'est visible)", async () => {
      const { reg, ecole, entreprise } = await deploy();
      await reg.connect(ecole).issue(hStage, Doc.ATTESTATION_STAGE);
      await expect(reg.connect(ecole).issue(hStage, Doc.ATTESTATION_STAGE)).to.be.revertedWithCustomError(reg, "AlreadyIssued").withArgs(hStage);
      // v2 : changement VOULU (correction du blocage par « squat », voir N4)
      await reg.connect(entreprise).issue(hStage, Doc.ATTESTATION_STAGE);
      expect((await reg.verify(hStage)).map((v) => v.issuer)).to.deep.equal([ecole.address, entreprise.address]);
    });

    it("7. empreinte nulle refusée (v2 : plus d'URI, donc plus de test de longueur d'URI)", async () => {
      const { reg, ecole } = await deploy();
      await expect(reg.connect(ecole).issue(ethers.ZeroHash, Doc.CFC)).to.be.revertedWithCustomError(reg, "ZeroHash");
      expect(reg.interface.getFunction("issue").inputs.map((i) => i.name)).to.deep.equal(["docHash", "docType"]);
    });

    it("8. un autre émetteur ne peut pas révoquer le certificat d'un émetteur (v2 : l'admin le peut via adminRevoke)", async () => {
      const { reg, admin, ecole, entreprise } = await deploy();
      await reg.connect(ecole).issue(hCfc, Doc.CFC);
      await expect(reg.connect(entreprise).revoke(hCfc, Reason.FRAUDE)).to.be.revertedWithCustomError(reg, "CertificateUnknown").withArgs(hCfc, entreprise.address);
      await expect(reg.connect(admin).revoke(hCfc, Reason.FRAUDE)).to.be.revertedWithCustomError(reg, "IssuerUnknown");
      await expect(reg.connect(ecole).revoke(hTravail, Reason.FRAUDE)).to.be.revertedWithCustomError(reg, "CertificateUnknown");
      expect((await one(reg, hCfc)).revoked).to.equal(false);
    });

    it("9. révocation par l'émetteur d'origine : visible, pas de double révocation, raison obligatoire", async () => {
      const { reg, ecole } = await deploy();
      await reg.connect(ecole).issue(hCfc, Doc.CFC);
      await expect(reg.connect(ecole).revoke(hCfc, Reason.NONE)).to.be.revertedWithCustomError(reg, "InvalidReason");
      await expect(reg.connect(ecole).revoke(hCfc, Reason.ERREUR_SAISIE)).to.emit(reg, "CertificateRevoked").withArgs(hCfc, ecole.address, Reason.ERREUR_SAISIE, false);
      const v = await one(reg, hCfc);
      expect(v.revoked).to.equal(true);
      expect(v.revokedByAdmin).to.equal(false);
      expect(v.revokedAt).to.be.greaterThan(0n);
      expect(v.revokeReason).to.equal(Reason.ERREUR_SAISIE);
      await expect(reg.connect(ecole).revoke(hCfc, Reason.AUTRE)).to.be.revertedWithCustomError(reg, "AlreadyRevoked");
      await expect(reg.connect(ecole).revoke(hCfc, 9)).to.be.reverted;
      await expect(reg.connect(ecole).issue(hCfc, Doc.CFC)).to.be.revertedWithCustomError(reg, "AlreadyIssued");
    });

    it("10. émetteur suspendu : anciens certificats visibles, émissions bloquées, réactivation (v2 : il ne peut PLUS révoquer)", async () => {
      const { reg, ecole } = await deploy();
      await reg.connect(ecole).issue(hCfc, Doc.CFC);
      await expect(reg.suspendIssuer(ecole.address, 0)).to.emit(reg, "IssuerSuspended");
      const v = await one(reg, hCfc);
      expect(v.issuerActive).to.equal(false);
      expect(v.issuerSuspendedAt).to.be.greaterThanOrEqual(v.issuedAt);
      expect(v.issuedWhileDistrusted).to.equal(false); // v2 : émis avant la suspension -> reste valable
      await expect(reg.connect(ecole).issue(hStage, Doc.ATTESTATION_STAGE)).to.be.revertedWithCustomError(reg, "IssuerNotActive");
      await expect(reg.suspendIssuer(ecole.address, 0)).to.be.revertedWithCustomError(reg, "IssuerNotActive");
      // v2 : changement VOULU (voir N3)
      await expect(reg.connect(ecole).revoke(hCfc, Reason.FRAUDE)).to.be.revertedWithCustomError(reg, "IssuerNotActive");
      await expect(reg.reactivateIssuer(ecole.address)).to.emit(reg, "IssuerReactivated");
      expect((await one(reg, hCfc)).issuerSuspendedAt).to.equal(0n);
      await reg.connect(ecole).issue(hStage, Doc.ATTESTATION_STAGE);
    });

    it("11. approbation : adresse zéro, nom vide, nom trop long, double approbation refusés", async () => {
      const { reg, ecole, inconnu } = await deploy();
      await expect(reg.approveIssuer(ethers.ZeroAddress, "X", Kind.ECOLE_PRO)).to.be.revertedWithCustomError(reg, "ZeroAddress");
      await expect(reg.approveIssuer(inconnu.address, "", Kind.ECOLE_PRO)).to.be.revertedWithCustomError(reg, "EmptyName");
      await expect(reg.approveIssuer(inconnu.address, "x".repeat(101), Kind.ECOLE_PRO)).to.be.revertedWithCustomError(reg, "NameTooLong");
      await expect(reg.approveIssuer(ecole.address, "Encore", Kind.EMPLOYEUR)).to.be.revertedWithCustomError(reg, "IssuerAlreadyApproved");
      await expect(reg.suspendIssuer(inconnu.address, 0)).to.be.revertedWithCustomError(reg, "IssuerUnknown");
      await expect(reg.reactivateIssuer(ecole.address)).to.be.revertedWithCustomError(reg, "IssuerAlreadyActive");
    });

    it("12. pause : émission bloquée ; vérification et révocation continuent ; reprise", async () => {
      const { reg, ecole } = await deploy();
      await reg.connect(ecole).issue(hCfc, Doc.CFC);
      await reg.pause();
      await expect(reg.connect(ecole).issue(hStage, Doc.ATTESTATION_STAGE)).to.be.revertedWithCustomError(reg, "EnforcedPause");
      expect((await reg.verify(hCfc)).length).to.equal(1);
      await reg.connect(ecole).revoke(hCfc, Reason.REMPLACE);
      await reg.unpause();
      await reg.connect(ecole).issue(hStage, Doc.ATTESTATION_STAGE);
    });

    it("13. un PDF modifié d'un seul octet donne 'inconnu'", async () => {
      const { reg, ecole } = await deploy();
      const a = fs.readFileSync(path.join(EX, "exemple-cfc-informaticien.pdf"));
      const b = fs.readFileSync(path.join(EX, "exemple-cfc-informaticien-FALSIFIE.pdf"));
      expect(a.length).to.equal(b.length);
      let diff = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff++;
      expect(diff).to.equal(1);
      expect(hFalsifie).to.not.equal(hCfc);
      await reg.connect(ecole).issue(hCfc, Doc.CFC);
      expect((await reg.verify(hCfc)).length).to.equal(1);
      expect((await reg.verify(hFalsifie)).length).to.equal(0); // v2 : tableau vide = inconnu
      expect((await reg.verifyFor(hFalsifie, ecole.address)).issuer).to.equal(ethers.ZeroAddress);
    });

    it("14. garde-fou : le rôle admin ne peut pas aller à l'adresse zéro (constructeur et grantRole)", async () => {
      const F = await ethers.getContractFactory("CertificateRegistry");
      await expect(F.deploy(ethers.ZeroAddress)).to.be.revertedWithCustomError(F, "ZeroAddress");
      const { reg } = await deploy();
      await expect(reg.grantRole(await reg.DEFAULT_ADMIN_ROLE(), ethers.ZeroAddress)).to.be.revertedWithCustomError(reg, "ZeroAddress");
    });

    it("15. transmission de l'admin (ex. vers le Safe) puis renonciation de l'ancien", async () => {
      const { reg, admin, recruteur: safe } = await deploy();
      const ADMIN = await reg.DEFAULT_ADMIN_ROLE();
      await reg.grantRole(ADMIN, safe.address);
      expect(await reg.adminCount()).to.equal(2n);
      await reg.renounceRole(ADMIN, admin.address);
      expect(await reg.adminCount()).to.equal(1n);
      expect(await reg.hasRole(ADMIN, admin.address)).to.equal(false);
      await expect(reg.connect(admin).pause()).to.be.revertedWithCustomError(reg, "AccessControlUnauthorizedAccount");
      await reg.connect(safe).pause();
    });

    it("16. aucune donnée personnelle dans la transaction : seulement l'empreinte et le type", async () => {
      const { reg, ecole } = await deploy();
      const rc = await (await reg.connect(ecole).issue(hCfc, Doc.CFC)).wait();
      const data = (await ethers.provider.getTransaction(rc.hash)).data;
      expect((data.length - 2) / 2).to.equal(4 + 32 + 32); // v2 : sélecteur + empreinte + type, rien d'autre
      expect(Buffer.from(data.slice(2), "hex").toString("latin1")).to.not.match(/EXEMPLE|FICTIF|Léa/);
    });

    it("17. coût en gaz d'une émission (mesuré)", async () => {
      const { reg, ecole, entreprise, admin } = await deploy();
      const r1 = await (await reg.connect(ecole).issue(hCfc, Doc.CFC)).wait();
      const r2 = await (await reg.connect(entreprise).issue(hCfc, Doc.ATTESTATION_STAGE)).wait();
      const r3 = await (await reg.connect(ecole).revoke(hCfc, Reason.ERREUR_SAISIE)).wait();
      const r4 = await (await reg.adminRevoke(hCfc, entreprise.address, Reason.FRAUDE)).wait();
      const r5 = await (await reg.adminUnrevoke(hCfc, entreprise.address)).wait();
      Object.assign(gasLog, { issuePremier: Number(r1.gasUsed), issueDeuxiemeEmetteurMemeEmpreinte: Number(r2.gasUsed), revoke: Number(r3.gasUsed),
        adminRevoke: Number(r4.gasUsed), adminUnrevoke: Number(r5.gasUsed), verifyEstimate2Emetteurs: Number(await reg.verify.estimateGas(hCfc)) });
      console.log("      gaz :", JSON.stringify(gasLog));
      expect(r1.gasUsed).to.be.lessThan(120000n);
      fs.mkdirSync(path.join(__dirname, "..", "logs"), { recursive: true });
      fs.mkdirSync(path.join(__dirname, "..", "logs"), { recursive: true }); fs.writeFileSync(path.join(__dirname, "..", "logs", "gas.json"), JSON.stringify(gasLog, null, 2) + "\n");
    });
  });

  describe("Nouveaux tests des corrections", function () {
    it("N2. données personnelles : aucun champ texte libre dans issue/verify/événements", async () => {
      const { reg } = await deploy();
      const abi = reg.interface.fragments.map((f) => f.format("full"));
      expect(abi.join("\n")).to.not.match(/metadata|uri/i);
      const ev = reg.interface.getEvent("CertificateIssued").inputs.map((i) => i.type);
      expect(ev).to.deep.equal(["bytes32", "address", "uint8"]);
    });

    it("N3a. émetteur suspendu : révocation refusée, l'admin révoque (événement byAdmin=true)", async () => {
      const { reg, admin, ecole } = await deploy();
      await reg.connect(ecole).issue(hCfc, Doc.CFC);
      await reg.suspendIssuer(ecole.address, 0);
      await expect(reg.connect(ecole).revoke(hCfc, Reason.FRAUDE)).to.be.revertedWithCustomError(reg, "IssuerNotActive");
      await expect(reg.adminRevoke(hCfc, ecole.address, Reason.FRAUDE)).to.emit(reg, "CertificateRevoked").withArgs(hCfc, ecole.address, Reason.FRAUDE, true);
      const v = await one(reg, hCfc);
      expect(v.revoked).to.equal(true); expect(v.revokedByAdmin).to.equal(true);
      await expect(reg.adminRevoke(hCfc, ecole.address, Reason.FRAUDE)).to.be.revertedWithCustomError(reg, "AlreadyRevoked");
      await expect(reg.adminRevoke(hCfc, admin.address, Reason.FRAUDE)).to.be.revertedWithCustomError(reg, "CertificateUnknown");
      await expect(reg.adminRevoke(hStage, ecole.address, Reason.NONE)).to.be.revertedWithCustomError(reg, "CertificateUnknown");
    });

    it("N3b. annulation de révocation : admin seulement, datée et publique ; l'émetteur ne peut pas", async () => {
      const { reg, admin, ecole } = await deploy();
      await reg.connect(ecole).issue(hCfc, Doc.CFC);
      await expect(reg.adminUnrevoke(hCfc, ecole.address)).to.be.revertedWithCustomError(reg, "NotRevoked");
      await reg.connect(ecole).revoke(hCfc, Reason.ERREUR_SAISIE);
      expect(reg.interface.getFunction("unrevoke")).to.equal(null);
      await expect(reg.adminUnrevoke(hCfc, ecole.address)).to.emit(reg, "CertificateUnrevoked").withArgs(hCfc, ecole.address, admin.address);
      const v = await one(reg, hCfc);
      expect(v.revoked).to.equal(false); expect(v.revokeReason).to.equal(Reason.NONE); expect(v.unrevokedAt).to.be.greaterThan(0n);
      await reg.connect(ecole).revoke(hCfc, Reason.REMPLACE); // peut être révoqué à nouveau
      expect((await one(reg, hCfc)).revoked).to.equal(true);
    });

    it("N3c. l'admin peut révoquer pendant la pause", async () => {
      const { reg, ecole } = await deploy();
      await reg.connect(ecole).issue(hCfc, Doc.CFC); await reg.pause();
      await reg.adminRevoke(hCfc, ecole.address, Reason.FRAUDE);
      expect((await one(reg, hCfc)).revoked).to.equal(true);
    });

    it("N4a. squat : un autre émetteur qui enregistre l'empreinte en premier ne bloque plus le vrai émetteur", async () => {
      const { reg, ecole, entreprise } = await deploy();
      await reg.connect(entreprise).issue(hStage, Doc.ATTESTATION_STAGE); // passe devant
      await reg.connect(ecole).issue(hStage, Doc.ATTESTATION_STAGE); // le vrai émetteur n'est pas bloqué
      const all = await reg.verify(hStage);
      expect(all.map((v) => v.issuerName)).to.deep.equal(["Atelier Démo Sàrl", "École professionnelle Exemple de Lausanne"]);
      expect((await reg.verifyFor(hStage, ecole.address)).issuer).to.equal(ecole.address);
    });

    it("N4b. nombre d'émetteurs par empreinte borné (gaz de verify borné)", async () => {
      const { reg, admin } = await deploy();
      const signers = (await ethers.getSigners()).slice(8, 14);
      for (const [k, s] of signers.entries()) await reg.approveIssuer(s.address, "Ecole " + k, Kind.ECOLE_PRO);
      const h = ethers.id("doc");
      for (const s of signers.slice(0, 5)) await reg.connect(s).issue(h, Doc.CFC);
      await expect(reg.connect(signers[5]).issue(h, Doc.CFC)).to.be.revertedWithCustomError(reg, "TooManyIssuersForHash");
      expect((await reg.verify(h)).length).to.equal(5);
      admin;
    });

    it("N5a. noms uniques (casse ASCII ignorée), caractères de contrôle et espaces douteux refusés", async () => {
      const { reg, ecole, inconnu, autre } = await deploy();
      await expect(reg.approveIssuer(inconnu.address, "École professionnelle Exemple de Lausanne", Kind.ECOLE_PRO))
        .to.be.revertedWithCustomError(reg, "NameTaken").withArgs(ecole.address);
      await expect(reg.approveIssuer(inconnu.address, "ÉCOLE PROFESSIONNELLE EXEMPLE DE LAUSANNE".replace("ÉCOLE", "École"), Kind.ECOLE_PRO))
        .to.be.revertedWithCustomError(reg, "NameTaken");
      await expect(reg.approveIssuer(inconnu.address, "atelier démo sàrl", Kind.ECOLE_PRO)).to.be.revertedWithCustomError(reg, "NameTaken");
      for (const bad of [" Ecole", "Ecole ", "Eco  le", "Eco\nle", "Eco\u0000le", "Eco\u007fle"])
        await expect(reg.approveIssuer(inconnu.address, bad, Kind.ECOLE_PRO)).to.be.revertedWithCustomError(reg, "InvalidNameCharacters");
      await reg.approveIssuer(inconnu.address, "Autre École", Kind.ECOLE_PRO);
      expect(await reg.issuerByName("autre école")).to.equal(ethers.ZeroAddress); // « É » non ASCII : casse non repliée (limite documentée)
      expect(await reg.issuerByName("AUTRE École")).to.equal(inconnu.address);
      autre;
    });

    it("N5b. verify renvoie l'adresse de chaque émetteur (affichée à côté du nom)", async () => {
      const { reg, ecole } = await deploy();
      await reg.connect(ecole).issue(hCfc, Doc.CFC);
      expect((await one(reg, hCfc)).issuer).to.equal(ecole.address);
    });

    it("N6a. suspension : certificat émis AVANT la date de défiance reste valable, ceux émis après sont signalés", async () => {
      const { reg, ecole } = await deploy();
      await reg.connect(ecole).issue(hCfc, Doc.CFC); // avant le vol de clé
      await time.increase(3600);
      const vol = BigInt(await time.latest());
      await time.increase(60);
      await reg.connect(ecole).issue(hStage, Doc.ATTESTATION_STAGE); // émis avec la clé volée
      await time.increase(600);
      await expect(reg.suspendIssuer(ecole.address, vol + 10n)).to.emit(reg, "IssuerSuspended");
      expect((await one(reg, hCfc)).issuedWhileDistrusted).to.equal(false);
      expect((await one(reg, hStage)).issuedWhileDistrusted).to.equal(true);
      const w = await reg.distrustWindows(ecole.address);
      expect(w.length).to.equal(1); expect(w[0].until).to.equal(0n);
      // Réactivation : la période se ferme ; les nouvelles émissions ne sont pas signalées
      await reg.reactivateIssuer(ecole.address);
      await time.increase(5);
      const hNew = ethers.id("nouveau");
      await reg.connect(ecole).issue(hNew, Doc.CFC);
      expect((await one(reg, hNew)).issuedWhileDistrusted).to.equal(false);
      expect((await one(reg, hStage)).issuedWhileDistrusted).to.equal(true); // l'historique reste
      expect((await reg.distrustWindows(ecole.address))[0].until).to.be.greaterThan(0n);
    });

    it("N6b. date de défiance dans le futur refusée ; 0 = maintenant", async () => {
      const { reg, ecole } = await deploy();
      const now = BigInt(await time.latest());
      await expect(reg.suspendIssuer(ecole.address, now + 1000n)).to.be.revertedWithCustomError(reg, "InvalidDistrustDate");
      await reg.suspendIssuer(ecole.address, 0);
      const w = await reg.distrustWindows(ecole.address);
      expect(w[0].from).to.equal((await reg.getIssuer(ecole.address)).suspendedAt);
    });

    it("N7a. l'admin peut renommer un émetteur ; l'ancien nom est libéré ; collision refusée", async () => {
      const { reg, ecole, entreprise, inconnu } = await deploy();
      await reg.connect(ecole).issue(hCfc, Doc.CFC);
      await expect(reg.renameIssuer(ecole.address, "École pro Lausanne")).to.emit(reg, "IssuerRenamed")
        .withArgs(ecole.address, "École professionnelle Exemple de Lausanne", "École pro Lausanne");
      expect((await one(reg, hCfc)).issuerName).to.equal("École pro Lausanne");
      await expect(reg.renameIssuer(ecole.address, "ATELIER Démo Sàrl")).to.be.revertedWithCustomError(reg, "NameTaken").withArgs(entreprise.address);
      await reg.approveIssuer(inconnu.address, "École professionnelle Exemple de Lausanne", Kind.ECOLE_PRO); // ancien nom libre
      await reg.renameIssuer(ecole.address, "école pro lausanne"); // simple changement de casse : autorisé
      await expect(reg.renameIssuer(inconnu.address, "x")).to.not.be.reverted;
      await expect(reg.renameIssuer(ethers.Wallet.createRandom().address, "y")).to.be.revertedWithCustomError(reg, "IssuerUnknown");
    });

    it("N7b. le dernier administrateur ne peut ni renoncer ni être retiré", async () => {
      const { reg, admin, autre } = await deploy();
      const ADMIN = await reg.DEFAULT_ADMIN_ROLE();
      expect(await reg.adminCount()).to.equal(1n);
      await expect(reg.renounceRole(ADMIN, admin.address)).to.be.revertedWithCustomError(reg, "LastAdmin");
      await expect(reg.revokeRole(ADMIN, admin.address)).to.be.revertedWithCustomError(reg, "LastAdmin");
      await reg.grantRole(ADMIN, autre.address);
      await reg.grantRole(ADMIN, autre.address); // déjà admin : pas de double comptage
      expect(await reg.adminCount()).to.equal(2n);
      await reg.revokeRole(ADMIN, autre.address);
      expect(await reg.adminCount()).to.equal(1n);
      await reg.revokeRole(ADMIN, autre.address); // déjà retiré : pas de décompte
      expect(await reg.adminCount()).to.equal(1n);
      await expect(reg.renounceRole(ADMIN, admin.address)).to.be.revertedWithCustomError(reg, "LastAdmin");
    });

    it("N7c. taille du contrat sous la limite EIP-170", async () => {
      const art = require("../artifacts/contracts/CertificateRegistry.sol/CertificateRegistry.json");
      const n = (art.deployedBytecode.length - 2) / 2;
      console.log("      taille déployée :", n, "octets");
      expect(n).to.be.lessThan(24576);
    });
  });
});
