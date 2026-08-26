# Running the Torch executor

The executor is the process that sends transactions: it accepts new orders,
relays fills, fires stops and liquidates. It is **not** the thing that decides
prices. Since Aug 12 the vault's executor is the
[`TorchTeeExecutor`](../contracts/contracts/TorchTeeExecutor.sol) adapter, which
refuses any entry price without a signature from an enclave Flare currently
attests ([extension 66154](../fce/README.md)).

That split is why this process can run on ordinary hosting. It pays gas and
picks the moment; it cannot invent a price, cannot withdraw, and cannot move
funds. The confidential compute that matters runs on Flare.

## Why not Phala any more

Torch ran the executor in a Phala Intel TDX enclave from July, when the key
holding the enclave *was* the trust story — before the adapter existed, the
operator could choose the entry price, and sealing the key was the only answer.
The adapter moved that guarantee on-chain and made the enclave redundant.

The enclave also had a standing cost. Its key was minted **inside** the TEE at
boot, so every restart, redeploy and credit lapse produced a new address, which
meant a `setExecutor`, a gas top-up, and whatever balance sat in the old key
stranded forever. Roughly 300 C2FLR went that way across three outages, and the
service finally died when the credits ran out.

Here the key is supplied through the environment. Restarts are free, which also
means the healthcheck below can safely restart a wedged loop — previously the
cure was worse than the disease.

## First-time setup

1. **Generate the key** (once). It lands in `agent/.env.railway.local`, mode
   600 and gitignored:

   ```
   node -e "const{generatePrivateKey,privateKeyToAccount}=require('viem/accounts');const pk=generatePrivateKey();console.log(pk,privateKeyToAccount(pk).address)"
   ```

2. **Authorize it** on the adapter, from the owner key:

   ```
   AGENT_NEW=0x<address> npm run set:agent -w contracts
   ```

   This is the only on-chain step. It touches the adapter, never the vault, and
   is reversible with the same command.

3. **Fund it** with C2FLR for gas. Keep it modest — 30–40 is plenty, topped up
   as needed. A large balance is only a larger loss if a key is ever lost.

4. **Create the Railway service**: New Service → GitHub repo → set **Root
   Directory** to `agent`. Railway reads [`railway.json`](railway.json) and
   builds [`Dockerfile`](Dockerfile).

5. **Set the variables** from [`.env.railway.example`](.env.railway.example),
   pasting `EXECUTOR_PRIVATE_KEY` from `.env.railway.local` and `HL_PRIVATE_KEY`
   from your trade-only API wallet.

   Do **not** set `ENCLAVE_KEYGEN` or `DSTACK`. Either one makes the agent mint
   a throwaway key at every boot, which reintroduces exactly the failure this
   migration removes.

## Checking it worked

The agent serves JSON status on every path, and answers **503** when its loop
has stopped ticking, so an uptime check cannot see green while nothing fills.

```
curl -s https://<service>.up.railway.app | jq '{executionMode, executor, loop, gas}'
```

At boot the log states whether the key is actually authorized:

```
authority  adapter.agent = 0x… (ok)
```

If it is not, the log prints the exact `set:agent` command instead. That check
reads the chain live rather than trusting `src/generated/deployments.json`,
whose `executor` field has been stale since the vault moved to the adapter.

## Rolling back

Point the adapter at another key with `set:agent`, or take the adapter out of
the path entirely with `EXECUTOR_NEW=0x… npm run set:executor -w contracts`.
Both are one owner transaction and need no redeploy: the agent re-reads
`vault.executor()` every 15 seconds and follows it in either direction.
