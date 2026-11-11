// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

/// @title  CertificateRegistry v2 (PROTOTYPE LOCAL - NON AUDITÉ)
/// @notice Registre de certificats suisses vérifiables : CFC, AFP, attestations de stage
///         et certificats de travail.
///
/// IDÉE SIMPLE
/// -----------
/// 1. L'administrateur (en production : le Safe 2 sur 3) approuve des émetteurs avec un NOM UNIQUE.
/// 2. Un émetteur enregistre l'EMPREINTE (keccak256) du PDF du certificat.
/// 3. N'importe qui peut ensuite vérifier un PDF : on recalcule son empreinte et on demande
///    au registre QUELS émetteurs l'ont enregistrée, quand, et si c'est révoqué.
///
/// CORRECTIONS v2 (10 nov. 2026)
/// -----------------------------
/// - Registre indexé par (empreinte, émetteur) : un émetteur ne peut plus bloquer l'empreinte
///   d'un autre en l'enregistrant avant lui. La vérification renvoie TOUS les émetteurs d'une empreinte.
/// - Plus aucun champ texte libre (metadataURI supprimé) : seulement empreinte + type.
/// - Un émetteur suspendu ne peut plus révoquer. L'admin peut révoquer ("écarter") et annuler
///   une révocation (événements publics).
/// - Noms d'émetteurs uniques (insensibles à la casse ASCII), renommage par l'admin.
/// - Suspension avec "date de défiance" : les certificats émis AVANT restent valables,
///   ceux émis entre cette date et la réactivation sont signalés.
/// - Impossible de retirer le dernier administrateur.
///
/// PROTECTION DES DONNÉES (nLPD suisse) : aucune donnée personnelle n'est écrite ici, mais
/// l'empreinte d'un document personnel peut rester une donnée personnelle pseudonymisée et elle
/// ne peut pas être effacée. Le PDF doit contenir un numéro de série ALÉATOIRE (>= 128 bits).
/// Avis juridique nLPD requis avant tout usage réel.
contract CertificateRegistry is AccessControl, Pausable {
    enum IssuerKind {
        ECOLE_PRO,
        ENTREPRISE_FORMATRICE,
        EMPLOYEUR
    }

    enum DocType {
        CFC,
        AFP,
        ATTESTATION_STAGE,
        CERTIFICAT_TRAVAIL
    }

    enum RevokeReason {
        NONE,
        ERREUR_SAISIE,
        REMPLACE,
        FRAUDE,
        AUTRE
    }

    struct Issuer {
        string name;
        IssuerKind kind;
        bool approved;
        bool active;
        uint64 approvedAt;
        uint64 suspendedAt; // 0 si actif
    }

    /// @notice Période pendant laquelle les émissions d'un émetteur ne sont plus dignes de confiance
    ///         (ex. clé volée). until == 0 : période encore ouverte (émetteur suspendu).
    struct DistrustWindow {
        uint64 from;
        uint64 until;
    }

    struct Certificate {
        DocType docType;
        uint64 issuedAt; // 0 = n'existe pas
        bool revoked;
        bool revokedByAdmin;
        RevokeReason revokeReason;
        uint64 revokedAt;
        uint64 unrevokedAt; // > 0 si l'admin a annulé une révocation
    }

    struct Verification {
        address issuer;
        string issuerName;
        IssuerKind issuerKind;
        bool issuerActive;
        uint64 issuerSuspendedAt;
        DocType docType;
        uint64 issuedAt;
        bool revoked;
        bool revokedByAdmin;
        RevokeReason revokeReason;
        uint64 revokedAt;
        uint64 unrevokedAt;
        bool issuedWhileDistrusted; // émis pendant une période de défiance
    }

    uint256 public constant MAX_NAME_LENGTH = 100;
    uint256 public constant MAX_ISSUERS_PER_HASH = 5;

    mapping(address => Issuer) private _issuers;
    mapping(bytes32 => address) private _nameOwner; // clé de nom normalisée -> émetteur
    mapping(address => DistrustWindow[]) private _windows;
    mapping(bytes32 => mapping(address => Certificate)) private _certs;
    mapping(bytes32 => address[]) private _hashIssuers;

    /// @notice Nombre d'administrateurs (le dernier ne peut pas être retiré).
    uint256 public adminCount;

    event IssuerApproved(address indexed issuer, string name, IssuerKind kind);
    event IssuerRenamed(address indexed issuer, string oldName, string newName);
    event IssuerSuspended(address indexed issuer, uint64 since, uint64 distrustFrom);
    event IssuerReactivated(address indexed issuer, uint64 at);
    event CertificateIssued(bytes32 indexed docHash, address indexed issuer, DocType docType);
    event CertificateRevoked(bytes32 indexed docHash, address indexed issuer, RevokeReason reason, bool byAdmin);
    event CertificateUnrevoked(bytes32 indexed docHash, address indexed issuer, address indexed admin);

    error ZeroAddress();
    error EmptyName();
    error NameTooLong();
    error InvalidNameCharacters();
    error NameTaken(address owner);
    error IssuerAlreadyApproved(address issuer);
    error IssuerUnknown(address issuer);
    error IssuerNotActive(address issuer);
    error IssuerAlreadyActive(address issuer);
    error InvalidDistrustDate();
    error ZeroHash();
    error AlreadyIssued(bytes32 docHash);
    error TooManyIssuersForHash(bytes32 docHash);
    error TypeNotAllowedForIssuer(IssuerKind kind, DocType docType);
    error CertificateUnknown(bytes32 docHash, address issuer);
    error AlreadyRevoked(bytes32 docHash);
    error NotRevoked(bytes32 docHash);
    error InvalidReason();
    error LastAdmin();

    constructor(address admin) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    // ------------------------------------------------------------------ administration

    function approveIssuer(address issuer, string calldata name, IssuerKind kind)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        if (issuer == address(0)) revert ZeroAddress();
        if (_issuers[issuer].approved) revert IssuerAlreadyApproved(issuer);
        _claimName(issuer, name);
        _issuers[issuer] = Issuer({
            name: name,
            kind: kind,
            approved: true,
            active: true,
            approvedAt: uint64(block.timestamp),
            suspendedAt: 0
        });
        emit IssuerApproved(issuer, name, kind);
    }

    /// @notice Renommer un émetteur (ex. faute de frappe, changement de raison sociale). L'ancien nom est libéré.
    function renameIssuer(address issuer, string calldata newName) external onlyRole(DEFAULT_ADMIN_ROLE) {
        Issuer storage i = _issuers[issuer];
        if (!i.approved) revert IssuerUnknown(issuer);
        string memory old = i.name;
        bytes32 oldKey = _nameKey(bytes(old));
        delete _nameOwner[oldKey];
        _claimName(issuer, newName);
        i.name = newName;
        emit IssuerRenamed(issuer, old, newName);
    }

    /// @notice Suspendre un émetteur.
    /// @param distrustFrom Date (passée ou maintenant) à partir de laquelle ses émissions ne sont plus fiables,
    ///        par exemple la date probable d'un vol de clé. 0 = maintenant.
    ///        Les certificats émis AVANT cette date restent valables.
    function suspendIssuer(address issuer, uint64 distrustFrom) external onlyRole(DEFAULT_ADMIN_ROLE) {
        Issuer storage i = _issuers[issuer];
        if (!i.approved) revert IssuerUnknown(issuer);
        if (!i.active) revert IssuerNotActive(issuer);
        uint64 nowTs = uint64(block.timestamp);
        if (distrustFrom == 0) distrustFrom = nowTs;
        if (distrustFrom > nowTs) revert InvalidDistrustDate();
        i.active = false;
        i.suspendedAt = nowTs;
        _windows[issuer].push(DistrustWindow({from: distrustFrom, until: 0}));
        emit IssuerSuspended(issuer, nowTs, distrustFrom);
    }

    function reactivateIssuer(address issuer) external onlyRole(DEFAULT_ADMIN_ROLE) {
        Issuer storage i = _issuers[issuer];
        if (!i.approved) revert IssuerUnknown(issuer);
        if (i.active) revert IssuerAlreadyActive(issuer);
        i.active = true;
        i.suspendedAt = 0;
        DistrustWindow[] storage w = _windows[issuer];
        uint64 nowTs = uint64(block.timestamp);
        // Fin de la période de défiance. Les émissions sont bloquées pendant la suspension, donc
        // "until" = maintenant + 1 s : aucune émission future n'est couverte.
        w[w.length - 1].until = nowTs + 1;
        emit IssuerReactivated(issuer, nowTs);
    }

    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    /// @notice Révocation par l'administrateur ("écarté") : fraude, émetteur compromis, enregistrement abusif.
    function adminRevoke(bytes32 docHash, address issuer, RevokeReason reason) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _revoke(docHash, issuer, reason, true);
    }

    /// @notice Annuler une révocation (ex. révocations massives faites avec une clé volée).
    ///         Réservé à l'admin (le Safe), jamais à l'émetteur, et toujours visible (événement + date).
    function adminUnrevoke(bytes32 docHash, address issuer) external onlyRole(DEFAULT_ADMIN_ROLE) {
        Certificate storage c = _certs[docHash][issuer];
        if (c.issuedAt == 0) revert CertificateUnknown(docHash, issuer);
        if (!c.revoked) revert NotRevoked(docHash);
        c.revoked = false;
        c.revokedByAdmin = false;
        c.revokeReason = RevokeReason.NONE;
        c.revokedAt = 0;
        c.unrevokedAt = uint64(block.timestamp);
        emit CertificateUnrevoked(docHash, issuer, msg.sender);
    }

    // ------------------------------------------------------------------ émetteurs

    /// @notice Enregistrer l'empreinte d'un certificat (keccak256 des octets EXACTS du PDF).
    function issue(bytes32 docHash, DocType docType) external whenNotPaused {
        Issuer storage i = _issuers[msg.sender];
        if (!i.approved) revert IssuerUnknown(msg.sender);
        if (!i.active) revert IssuerNotActive(msg.sender);
        if (docHash == bytes32(0)) revert ZeroHash();
        if (!isTypeAllowed(i.kind, docType)) revert TypeNotAllowedForIssuer(i.kind, docType);
        Certificate storage c = _certs[docHash][msg.sender];
        if (c.issuedAt != 0) revert AlreadyIssued(docHash);
        address[] storage list = _hashIssuers[docHash];
        if (list.length >= MAX_ISSUERS_PER_HASH) revert TooManyIssuersForHash(docHash);
        list.push(msg.sender);
        c.docType = docType;
        c.issuedAt = uint64(block.timestamp);
        emit CertificateIssued(docHash, msg.sender, docType);
    }

    /// @notice Révoquer SON certificat. Interdit si l'émetteur est suspendu (clé peut-être volée) :
    ///         dans ce cas, seul l'admin peut révoquer. Possible pendant la pause.
    function revoke(bytes32 docHash, RevokeReason reason) external {
        Issuer storage i = _issuers[msg.sender];
        if (!i.approved) revert IssuerUnknown(msg.sender);
        if (!i.active) revert IssuerNotActive(msg.sender);
        _revoke(docHash, msg.sender, reason, false);
    }

    function _revoke(bytes32 docHash, address issuer, RevokeReason reason, bool byAdmin) private {
        Certificate storage c = _certs[docHash][issuer];
        if (c.issuedAt == 0) revert CertificateUnknown(docHash, issuer);
        if (c.revoked) revert AlreadyRevoked(docHash);
        if (reason == RevokeReason.NONE) revert InvalidReason();
        c.revoked = true;
        c.revokedByAdmin = byAdmin;
        c.revokeReason = reason;
        c.revokedAt = uint64(block.timestamp);
        emit CertificateRevoked(docHash, issuer, reason, byAdmin);
    }

    // ------------------------------------------------------------------ lecture

    /// @notice Tous les enregistrements d'une empreinte (0 à MAX_ISSUERS_PER_HASH). Tableau vide = inconnu ou modifié.
    function verify(bytes32 docHash) external view returns (Verification[] memory out) {
        address[] storage list = _hashIssuers[docHash];
        out = new Verification[](list.length);
        for (uint256 k = 0; k < list.length; k++) {
            out[k] = _verification(docHash, list[k]);
        }
    }

    /// @notice Enregistrement d'une empreinte par UN émetteur précis (issuedAt == 0 : n'existe pas).
    function verifyFor(bytes32 docHash, address issuer) external view returns (Verification memory) {
        return _verification(docHash, issuer);
    }

    function _verification(bytes32 docHash, address issuer) private view returns (Verification memory v) {
        Certificate storage c = _certs[docHash][issuer];
        if (c.issuedAt == 0) return v;
        Issuer storage i = _issuers[issuer];
        v.issuer = issuer;
        v.issuerName = i.name;
        v.issuerKind = i.kind;
        v.issuerActive = i.active;
        v.issuerSuspendedAt = i.suspendedAt;
        v.docType = c.docType;
        v.issuedAt = c.issuedAt;
        v.revoked = c.revoked;
        v.revokedByAdmin = c.revokedByAdmin;
        v.revokeReason = c.revokeReason;
        v.revokedAt = c.revokedAt;
        v.unrevokedAt = c.unrevokedAt;
        v.issuedWhileDistrusted = wasDistrustedAt(issuer, c.issuedAt);
    }

    /// @notice true si `ts` tombe dans une période de défiance de l'émetteur.
    function wasDistrustedAt(address issuer, uint64 ts) public view returns (bool) {
        DistrustWindow[] storage w = _windows[issuer];
        for (uint256 k = 0; k < w.length; k++) {
            if (ts >= w[k].from && (w[k].until == 0 || ts < w[k].until)) return true;
        }
        return false;
    }

    function getIssuer(address issuer) external view returns (Issuer memory) {
        return _issuers[issuer];
    }

    function distrustWindows(address issuer) external view returns (DistrustWindow[] memory) {
        return _windows[issuer];
    }

    /// @notice Émetteur qui porte ce nom (comparaison insensible à la casse ASCII), address(0) si libre.
    function issuerByName(string calldata name) external view returns (address) {
        return _nameOwner[_nameKey(bytes(name))];
    }

    function isTypeAllowed(IssuerKind kind, DocType docType) public pure returns (bool) {
        if (kind == IssuerKind.ECOLE_PRO) {
            return docType != DocType.CERTIFICAT_TRAVAIL;
        }
        return docType == DocType.ATTESTATION_STAGE || docType == DocType.CERTIFICAT_TRAVAIL;
    }

    // ------------------------------------------------------------------ noms

    /// @dev Vérifie le nom et le réserve pour `issuer`. Refuse : vide, trop long, caractères de contrôle,
    ///      espace au début/à la fin, double espace, nom déjà pris (casse ASCII ignorée).
    function _claimName(address issuer, string calldata name) private returns (bytes32 key) {
        bytes calldata b = bytes(name);
        if (b.length == 0) revert EmptyName();
        if (b.length > MAX_NAME_LENGTH) revert NameTooLong();
        if (b[0] == 0x20 || b[b.length - 1] == 0x20) revert InvalidNameCharacters();
        for (uint256 k = 0; k < b.length; k++) {
            uint8 ch = uint8(b[k]);
            if (ch < 0x20 || ch == 0x7f) revert InvalidNameCharacters();
            if (ch == 0x20 && k > 0 && uint8(b[k - 1]) == 0x20) revert InvalidNameCharacters();
        }
        key = _nameKey(b);
        address owner = _nameOwner[key];
        if (owner != address(0) && owner != issuer) revert NameTaken(owner);
        _nameOwner[key] = issuer;
    }

    function _nameKey(bytes memory b) private pure returns (bytes32) {
        bytes memory low = new bytes(b.length);
        for (uint256 k = 0; k < b.length; k++) {
            bytes1 ch = b[k];
            low[k] = (ch >= 0x41 && ch <= 0x5a) ? bytes1(uint8(ch) + 32) : ch;
        }
        return keccak256(low);
    }

    // ------------------------------------------------------------------ rôles

    function _grantRole(bytes32 role, address account) internal override returns (bool granted) {
        if (account == address(0)) revert ZeroAddress();
        granted = super._grantRole(role, account);
        if (granted && role == DEFAULT_ADMIN_ROLE) adminCount++;
    }

    /// @dev Couvre revokeRole ET renounceRole : le dernier administrateur ne peut pas partir.
    function _revokeRole(bytes32 role, address account) internal override returns (bool revoked) {
        if (role == DEFAULT_ADMIN_ROLE && adminCount == 1 && hasRole(role, account)) revert LastAdmin();
        revoked = super._revokeRole(role, account);
        if (revoked && role == DEFAULT_ADMIN_ROLE) adminCount--;
    }
}
