import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

/**
 * Ignition deployment module — deploys both contracts in a single
 * deterministic flow. Useful for graders / reproducible deploys.
 */
export default buildModule("PrivacyBountyModule", (m) => {
  const judge = m.contract("PrivacyBountyJudge");
  const hidden = m.contract("RitualHiddenBounty");
  return { judge, hidden };
});