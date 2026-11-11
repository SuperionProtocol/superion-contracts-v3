const {legacyFactory,legacyDraw,fulfillMock,oracle}=require('../helpers/legacy-vrf-fixture.cjs');
const {expect}=require("chai");
const {ethers,artifacts}=require("hardhat");
const {MARKETPLACE_V3_PARAMS_TESTNET:P}=require("../scripts/v3/config.cjs");
async function fixture(){
 const [admin,other]=await ethers.getSigners();
 const token=await(await ethers.getContractFactory("SuperionToken")).deploy(admin.address);
 const staking=await(await ethers.getContractFactory("SuperionStakingV2")).deploy(await token.getAddress(),admin.address,60);
 const market=await(await legacyFactory()).deploy(await token.getAddress(),await staking.getAddress(),admin.address,admin.address,other.address,admin.address,P);
 return {market};
}
describe("Size-only parameter validation refactor",function(){
 it("retains every original rejection predicate and both window boundaries",async function(){
  const {market}=await fixture();
  const bad=[{feeBps:1001},{treasuryShareBps:5001},{burnShareBps:9001},
   {challengePeriod:59},{challengePeriod:30*86400+1},{voteCommitWindow:59},{voteCommitWindow:14*86400+1},
   {voteRevealWindow:59},{voteRevealWindow:14*86400+1},{appealWindow:59},{appealWindow:14*86400+1},
   {arbitrationWindow:3599},{arbitrationWindow:60*86400+1},{committeeSize:1},{committeeSize:4},
   {appealCommitteeSize:3},{appealCommitteeSize:17},{appealCommitteeSize:6},{providerStakeBps:50001},
   {slashVerifierBps:10000,slashChallengerBps:1},{bondBps:10001},{penaltyBps:10001},{voteFeeBps:10001},
   {appealBondMultBps:9999},{maxJobStakeBps:0},{minVerifierStake:0n},
   {minBond:10n**15n-1n},{maxBond:P.minBond-1n},{minPenalty:P.maxPenalty+1n},
   {maxPenalty:P.minVerifierStake+1n},{minVoteFee:P.maxVoteFee+1n}];
  for(const change of bad)await expect((await require('hardhat').ethers.getContractAt('MissionTerms',await market.terms())).setParams({...P,...change})).to.be.revertedWithCustomError(market,"InvalidParams");
 });
 it("retains acceptance at valid boundary settings",async function(){
  const {market}=await fixture();
  const valid=[{feeBps:1000,burnShareBps:5000,treasuryShareBps:5000},
   {challengePeriod:60,voteCommitWindow:60,voteRevealWindow:60,appealWindow:60,arbitrationWindow:3600},
   {challengePeriod:30*86400,voteCommitWindow:14*86400,voteRevealWindow:14*86400,appealWindow:14*86400,arbitrationWindow:60*86400},
   {committeeSize:13,appealCommitteeSize:15,providerStakeBps:50000,bondBps:10000,penaltyBps:10000,voteFeeBps:10000,appealBondMultBps:10000,maxJobStakeBps:65535},
   {minBond:10n**15n,maxBond:10n**15n,minPenalty:0n,maxPenalty:0n,minVoteFee:0n,maxVoteFee:0n}];
  for(const change of valid){await (await require('hardhat').ethers.getContractAt('MissionTerms',await market.terms())).setParams({...P,...change});const actual=await (await require('hardhat').ethers.getContractAt('MissionTerms',await market.terms())).current();for(const [k,v]of Object.entries(change))expect(actual[k]).to.equal(BigInt(v));}
 });
 it("really deploys below EIP-170 with the size limit enabled",async function(){
  const {market}=await fixture();const code=await ethers.provider.getCode(await market.getAddress());
  const a=await artifacts.readArtifact("SuperionJobMarketplaceV3");
  expect((code.length-2)/2).to.equal((a.deployedBytecode.length-2)/2);
  expect((code.length-2)/2).to.be.at.most(24576);
 });
});
