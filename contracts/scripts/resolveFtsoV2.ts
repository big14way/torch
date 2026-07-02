import { ethers } from "hardhat";

// FlareContractRegistry lives at the same address on every Flare network.
// Documented canonical address; verify once at https://dev.flare.network
// (Network > Solidity Reference) before relying on it for mainnet.
const REGISTRY = "0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019";

const REGISTRY_ABI = [
  "function getContractAddressByName(string _name) external view returns (address)",
];

async function main() {
  const registry = new ethers.Contract(REGISTRY, REGISTRY_ABI, ethers.provider);
  const ftsoV2 = await registry.getContractAddressByName("FtsoV2");
  console.log(`FtsoV2 on this network: ${ftsoV2}`);
  console.log(`Add to contracts/.env ->  FTSOV2_ADDRESS=${ftsoV2}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
