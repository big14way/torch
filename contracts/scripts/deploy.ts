import { ethers, network, artifacts } from "hardhat";
import * as fs from "fs";
import * as path from "path";

// FTSOv2 feed ids (bytes21): 0x01 crypto category + ASCII name + zero padding.
// Verify the live list at https://dev.flare.network/ftso/feeds before mainnet.
const feedId = (name: string) =>
  "0x" + ("01" + Buffer.from(`${name}/USD`, "ascii").toString("hex")).padEnd(42, "0");

const FEEDS: Record<string, string> = {
  XRP: feedId("XRP"),
  BTC: feedId("BTC"),
  ETH: feedId("ETH"),
  HYPE: feedId("HYPE"),
  SOL: feedId("SOL"),
  DOGE: feedId("DOGE"),
};

const START_PRICES_6DP: Record<string, bigint> = {
  XRP: 2_850_000n, // 2.85 USD
  BTC: 96_500_000_000n, // 96,500 USD
  ETH: 4_420_000_000n, // 4,420 USD
  HYPE: 44_000_000n, // 44 USD
  SOL: 160_000_000n, // 160 USD
  DOGE: 220_000n, // 0.22 USD
};

function writeGenerated(payload: object, abiFiles: Record<string, unknown>) {
  const targets = [
    path.join(__dirname, "..", "..", "web", "src", "generated"),
    path.join(__dirname, "..", "..", "agent", "src", "generated"),
  ];
  for (const dir of targets) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "deployments.json"), JSON.stringify(payload, null, 2));
    for (const [name, abi] of Object.entries(abiFiles)) {
      fs.writeFileSync(path.join(dir, `${name}.abi.json`), JSON.stringify(abi, null, 2));
    }
  }
}

async function main() {
  const [deployer, defaultExecutor] = await ethers.getSigners();
  const isLocal = network.name === "localhost" || network.name === "hardhat";
  console.log(`Network: ${network.name} | Deployer: ${deployer.address}`);

  let fxrpAddress: string;
  let oracleAddress: string;
  let executorAddress: string;

  if (isLocal) {
    executorAddress = defaultExecutor.address;

    const MockFXRP = await ethers.getContractFactory("MockFXRP");
    const fxrp = await MockFXRP.deploy();
    await fxrp.waitForDeployment();
    fxrpAddress = await fxrp.getAddress();

    const MockFtsoV2 = await ethers.getContractFactory("MockFtsoV2");
    const oracle = await MockFtsoV2.deploy();
    await oracle.waitForDeployment();
    oracleAddress = await oracle.getAddress();

    for (const [key, feedId] of Object.entries(FEEDS)) {
      await (await oracle.setPrice(feedId, START_PRICES_6DP[key])).wait();
    }
    console.log(`MockFXRP:   ${fxrpAddress}`);
    console.log(`MockFtsoV2: ${oracleAddress}`);
  } else {
    // Coston2 / Songbird / Flare.
    // FXRP_ADDRESS: testnet FXRP from the Coston2 faucet page, or resolve it
    //   dynamically through the FAssets AssetManager (see README).
    // EXECUTOR_ADDRESS: the agent's address (TEE identity in production).
    // FtsoV2 needs no env: the reader resolves it through the
    //   FlareContractRegistry at read time (sanity-check with `npm run resolve:ftso`).
    fxrpAddress = requireEnv("FXRP_ADDRESS");
    executorAddress = process.env.EXECUTOR_ADDRESS || deployer.address;

    const Reader = await ethers.getContractFactory("FtsoV2Reader");
    const reader = await Reader.deploy();
    await reader.waitForDeployment();
    oracleAddress = await reader.getAddress();
    console.log(`FtsoV2Reader: ${oracleAddress}`);
  }

  const TorchVault = await ethers.getContractFactory("TorchVaultV2");
  const vault = await TorchVault.deploy(
    fxrpAddress,
    oracleAddress,
    FEEDS.XRP,
    executorAddress,
    deployer.address // treasury = deployer for the hackathon
  );
  await vault.waitForDeployment();
  const vaultAddress = await vault.getAddress();
  console.log(`TorchVault: ${vaultAddress}`);

  const markets: { key: string; id: string; feedId: string }[] = [];
  for (const [key, feedId] of Object.entries(FEEDS)) {
    const id = ethers.encodeBytes32String(key);
    await (await vault.listMarket(id, feedId, 100)).wait(); // 10x max
    markets.push({ key, id, feedId });
    console.log(`Listed ${key} (max 10x)`);
  }

  if (isLocal) {
    // Seed the demo: give deployer tFXRP and pre-fund the insurance pool so
    // profitable closes pay out on localhost.
    const fxrp = await ethers.getContractAt("MockFXRP", fxrpAddress);
    await (await fxrp.faucet()).wait();
    await (await fxrp.mint(deployer.address, 100_000n * 10n ** 6n)).wait();
    await (await fxrp.approve(vaultAddress, ethers.MaxUint256)).wait();
    await (await vault.fundInsurance(50_000n * 10n ** 6n)).wait();
    console.log("Seeded deployer with tFXRP and funded 50,000 tFXRP insurance.");
  }

  // v2 ABI, written under the stable TorchVault.abi.json name web/agent import.
  const vaultAbi = (await artifacts.readArtifact("TorchVaultV2")).abi;
  const fxrpAbi = (await artifacts.readArtifact("MockFXRP")).abi; // ERC20 surface
  const oracleAbi = (await artifacts.readArtifact("MockFtsoV2")).abi;

  const net = await ethers.provider.getNetwork();
  writeGenerated(
    {
      chainId: Number(net.chainId),
      network: network.name,
      mode: isLocal ? "local" : "coston2",
      vault: vaultAddress,
      fxrp: fxrpAddress,
      oracle: oracleAddress,
      executor: executorAddress,
      treasury: deployer.address,
      markets,
      deployedAt: new Date().toISOString(),
    },
    { TorchVault: vaultAbi, ERC20: fxrpAbi, MockFtsoV2: oracleAbi }
  );
  console.log("Wrote generated config + ABIs to web/ and agent/.");
}

function requireEnv(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`Missing env var ${key} (see .env.example)`);
  return v;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
