// LOCAL-only Hardhat config (chain 31337). No dotenv, accounts, fork, or public RPC.
require("@nomicfoundation/hardhat-toolbox");
const { subtask } = require("hardhat/config");
const { TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD } = require("hardhat/builtin-tasks/task-names");
if (process.env.SOLC_BINARY) subtask(TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD).setAction(async ({solcVersion}) => {
  if (solcVersion !== "0.8.24") throw new Error("Unexpected compiler version");
  return {compilerPath:process.env.SOLC_BINARY,isSolcJs:false,version:"0.8.24",longVersion:"0.8.24+commit.e11b9ed9"};
});
module.exports = {
 defaultNetwork:"hardhat",
 solidity:{compilers:[{version:"0.8.24",settings:{optimizer:{enabled:true,runs:200},evmVersion:"cancun",viaIR:true}}],overrides:{
  "contracts/SuperionToken.sol":{version:"0.8.24",settings:{optimizer:{enabled:false,runs:200},evmVersion:"paris"}},
  "contracts/vrf/FrozenVrfDraw.sol":{version:"0.8.24",settings:{optimizer:{enabled:true,runs:1},evmVersion:"cancun",viaIR:true}},
  "contracts/test/LocalVrfCoordinatorMock.sol":{version:"0.8.24",settings:{optimizer:{enabled:true,runs:1},evmVersion:"cancun",viaIR:true}},
  "contracts/governance/SuperionGovernanceTimelock.sol":{version:"0.8.24",settings:{optimizer:{enabled:true,runs:1},evmVersion:"cancun",viaIR:true}},
  "contracts/terms/MissionTerms.sol":{version:"0.8.24",settings:{optimizer:{enabled:true,runs:1},evmVersion:"cancun",viaIR:true}},
  "contracts/code/CodeMissionSuites.sol":{version:"0.8.24",settings:{optimizer:{enabled:true,runs:1},evmVersion:"cancun",viaIR:true}},
  "contracts/governance/SafeLocalGuard.sol":{version:"0.8.24",settings:{optimizer:{enabled:true,runs:1},evmVersion:"cancun",viaIR:true}},
  "contracts/v3/SuperionJobMarketplaceV3.sol":{version:"0.8.24",settings:{optimizer:{enabled:true,runs:1},evmVersion:"cancun",viaIR:true}}
 }},
 networks:{hardhat:{chainId:31337,hardfork:"cancun",allowUnlimitedContractSize:false,initialDate:"2026-11-08T00:00:00.000Z"}},
 paths:{sources:"./contracts",tests:"./test",cache:"./cache",artifacts:"./artifacts"},
 mocha:{timeout:120000,reporter:require.resolve("./helpers/evidence-reporter.cjs")}
};
