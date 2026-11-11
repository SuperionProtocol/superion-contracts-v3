// TESTNET deployment config: Base Sepolia (84532) ONLY. Same compiler settings as hardhat.config.cjs (imported).
// The deployer key and the explorer API key are read from environment variables only
// (PRIVATE_KEY, ETHERSCAN_API_KEY). Nothing secret is stored in this repository.
const local = require("./hardhat.config.cjs");
module.exports = {
  ...local,
  defaultNetwork: "baseSepolia",
  networks: {
    hardhat: local.networks.hardhat,
    baseSepolia: { url: "https://sepolia.base.org", chainId: 84532, accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [], gasMultiplier: 1.3 },
  },
  etherscan: { apiKey: process.env.ETHERSCAN_API_KEY || "" },
  sourcify: { enabled: false },
};
