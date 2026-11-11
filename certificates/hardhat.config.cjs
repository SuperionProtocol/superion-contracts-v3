// LOCAL-only configuration: no public network, no keys, no .env.
require("@nomicfoundation/hardhat-toolbox");
const { subtask } = require("hardhat/config");
const { TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD } = require("hardhat/builtin-tasks/task-names");
// Optional: use an already installed native solc (offline compiler reproduction).
if (process.env.SOLC_BINARY) subtask(TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD).setAction(async ({ solcVersion }) => {
  if (solcVersion !== "0.8.24") throw new Error("Unexpected compiler version");
  return { compilerPath: process.env.SOLC_BINARY, isSolcJs: false, version: "0.8.24", longVersion: "0.8.24+commit.e11b9ed9" };
});
module.exports = {
  defaultNetwork: "hardhat",
  solidity: { version: "0.8.24", settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "cancun", viaIR: true } },
  networks: {
    hardhat: { chainId: 31337, hardfork: "cancun", allowUnlimitedContractSize: false },
    // Only non-simulator network: a LOCAL Hardhat node.
    localhost: { url: "http://127.0.0.1:8545", chainId: 31337 }
  },
  paths: { sources: "./contracts", tests: "./test", cache: "./cache", artifacts: "./artifacts" },
  mocha: { timeout: 120000 }
};
