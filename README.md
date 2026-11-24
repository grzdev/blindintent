# BlindIntent

**MEV-proof, post-quantum sealed trading intents executed by policy-capped AI agents on QoreChain.**

Built for **Build Before Q-Day: The QoreChain Developer Fest** (`Post-Quantum AI Agents`).

- Sealed client-side with `@qorechain/qoreseal` (`ML-KEM-1024`) + `ML-DSA-87` commitments
- Executed on-chain via `x/abstractaccount` (`MsgExecuteEVM`) under strict per-tx, daily, target, and expiry limits
- Verified in Solidity via QoreChain PQC precompiles (`pqcVerify` `0x...0a01` & `pqcKeyStatus` `0x...0a02`)

*(Active development in progress — full contracts, bounded agent runtime, Explorer UI, Attack Lab, and testnet deployment coming shortly.)*

## License

Apache-2.0 — see [LICENSE](LICENSE).
