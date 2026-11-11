// DRY-RUN ONLY: local fork of Base Sepolia. Nothing is broadcast.
const base = require("./hardhat.sepolia.cjs");
module.exports = { ...base, defaultNetwork: "hardhat", networks: { hardhat: { chainId: 84532, hardfork: "cancun", forking: { url: "https://sepolia.base.org" } }, localhost: { url: "http://127.0.0.1:8546", chainId: 84532 } } };
