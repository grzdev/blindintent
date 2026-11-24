import "@rainbow-me/rainbowkit/styles.css";
import "./index.css";

import { RainbowKitProvider, darkTheme } from "@rainbow-me/rainbowkit";
import { QoreChainProvider } from "@qorechain/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { createRoot } from "react-dom/client";
import { WagmiProvider } from "wagmi";
import { App } from "./App.js";
import { wagmiConfig } from "./wagmi.js";

const queryClient = new QueryClient();

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider
          theme={darkTheme({
            accentColor: "#00D4B8",
            accentColorForeground: "#07090C",
            borderRadius: "medium",
          })}
        >
          <QoreChainProvider
            config={{
              network: "testnet",
              endpoints: {
                rest: "/lcd-testnet",
                evmRpc: "https://evm-testnet.qore.host",
              },
            }}
          >
            <App />
          </QoreChainProvider>
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  </React.StrictMode>,
);
