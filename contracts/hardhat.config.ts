import { HardhatUserConfig, subtask } from "hardhat/config";
import { TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD } from "hardhat/builtin-tasks/task-names";
import "@nomicfoundation/hardhat-toolbox";
import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config();

// Use the npm-pinned solc 0.8.24 (deterministic, works offline). If the
// pinned package is missing for any reason, fall back to Hardhat's normal
// compiler download.
subtask(TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD, async (args: any, _hre, runSuper) => {
  if (args.solcVersion === "0.8.24") {
    try {
      const solcPkg = require.resolve("solc/package.json", {
        paths: [path.join(__dirname, "node_modules"), __dirname],
      });
      const pkg = require(solcPkg);
      if (pkg.version === "0.8.24") {
        const compilerPath = path.join(path.dirname(solcPkg), "soljson.js");
        return {
          compilerPath,
          isSolcJs: true,
          version: "0.8.24",
          longVersion: "0.8.24+commit.e11b9ed9",
        };
      }
    } catch (_) {
      // fall through to default downloader
    }
  }
  return runSuper(args);
});

const PRIVATE_KEY = process.env.PRIVATE_KEY || "";

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.25",
    settings: {
      optimizer: { enabled: true, runs: 200 },
    },
  },
  networks: {
    hardhat: {
      chainId: 31337,
    },
    localhost: {
      url: "http://127.0.0.1:8545",
      chainId: 31337,
    },
    coston2: {
      url: process.env.COSTON2_RPC || "https://coston2-api.flare.network/ext/C/rpc",
      chainId: 114,
      accounts: PRIVATE_KEY ? [PRIVATE_KEY] : [],
    },
  },
  etherscan: {
    // Coston2 uses a Blockscout explorer (Etherscan-compatible API).
    // Blockscout accepts any non-empty API key string.
    apiKey: { coston2: "coston2" },
    customChains: [
      {
        network: "coston2",
        chainId: 114,
        urls: {
          apiURL: "https://coston2-explorer.flare.network/api",
          browserURL: "https://coston2-explorer.flare.network",
        },
      },
    ],
  },
};

export default config;
