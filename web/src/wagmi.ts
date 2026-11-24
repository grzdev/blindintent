import { connectorsForWallets } from "@rainbow-me/rainbowkit";
import { injectedWallet } from "@rainbow-me/rainbowkit/wallets";
import { qorechain, qorechainTestnet } from "@qorechain/evm";
import { qorexWallet } from "@qorechain/qorex-rainbowkit";
import { createConfig, http } from "wagmi";

type WagmiChains = Parameters<typeof createConfig>[0]["chains"];
const chains = [qorechainTestnet, qorechain] as unknown as WagmiChains;

const connectors = connectorsForWallets(
  [
    {
      groupName: "QoreChain Wallets",
      wallets: [() => qorexWallet({ pollAccountsOnFocus: true }), injectedWallet],
    },
  ],
  {
    appName: "BlindIntent",
    projectId: import.meta.env.VITE_WALLETCONNECT_PROJECT_ID ?? "blindintent-testnet",
  },
);

export const wagmiConfig = createConfig({
  chains,
  connectors,
  transports: {
    [qorechainTestnet.id]: http("https://evm-testnet.qore.host"),
    [qorechain.id]: http("https://evm.qore.host"),
  },
});
