// Minimal, local-only Hardhat config for the V3 audit snapshot.
// No networks, RPC URLs, keys or environment variables are read.
require("@nomicfoundation/hardhat-toolbox");

const DEFAULT = { optimizer: { enabled: true, runs: 200 }, evmVersion: "cancun", viaIR: true };
// SuperionToken: settings it was originally compiled/verified with.
const TOKEN = { optimizer: { enabled: false, runs: 200 }, evmVersion: "paris" };
// V3 marketplace: runs = 1 to stay under the EIP-170 size limit (24,576 bytes).
const V3 = { optimizer: { enabled: true, runs: 1 }, evmVersion: "cancun", viaIR: true };

module.exports = {
  solidity: {
    compilers: [{ version: "0.8.24", settings: DEFAULT }],
    overrides: {
      "contracts/SuperionToken.sol": { version: "0.8.24", settings: TOKEN },
      "contracts/v3/SuperionJobMarketplaceV3.sol": { version: "0.8.24", settings: V3 },
    },
  },
  networks: { hardhat: {} },
};
