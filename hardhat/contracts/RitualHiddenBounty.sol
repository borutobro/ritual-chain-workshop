// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PrivacyBountyJudge} from "./PrivacyBountyJudge.sol";

/**
 * @title RitualHiddenBounty
 * @notice Advanced Track: encrypted submissions evaluated by a Sovereign
 *         Agent running inside a Ritual TEE (0x080C).
 *
 * Flow
 * ────
 * 1.  Owner creates bounty (escrows reward).
 * 2.  Submitter encrypts `(answer, salt, msg.sender, bountyId)` with the TEE's
 *     secp256k1 public key (ECIES, nonce=12 bytes — see ritual-dapp-agents
 *     skill, the default of 16 causes silent failures).
 *     The TEE pubkey is fetched on-chain via the `SovereignAgentRegistry`
 *     (see `getAgentPubKey`) so submitters never need out-of-band config.
 * 3.  Submitter calls `submitSecret(bountyId, ciphertext)` — only the
 *     ciphertext is stored, plaintext never touches the chain.
 * 4.  After the deadline the owner calls `requestJudging(bountyId)`. This
 *     forwards every `(submitter, ciphertext)` blob to the TEE via the
 *     `SOVEREIGN_AGENT_PRECOMPILE` (0x080C). The TEE holds the matching
 *     secp256k1 private key, decrypts each blob, runs the LLM judge on the
 *     batch, and writes the winner index back via `deliverResult`.
 * 5.  Owner finalizes → reward paid atomically to the TEE-reported winner.
 *
 * Where plaintext lives
 * ─────────────────────
 * • `submitSecret` tx mempool: plaintext exists only inside the submitter's
 *   local signer memory before encryption. After the ciphertext is sent it is
 *   discarded by the client.
 * • `SOVEREIGN_AGENT_PRECOMPILE` input: the TEE receives ciphertext blobs.
 * • TEE enclave: plaintext is decrypted inside the enclave and used as the
 *   LLM prompt context. The enclave's attestation report (returned by the
 *   precompile) is logged so any observer can verify the judging happened
 *   inside a genuine TEE.
 * • On-chain: ONLY `(submitter, ciphertext, deadline, reward, aiReport,
 *   winnerIndex)`. The plaintext answer is never written to storage or logs.
 *
 * Public vs hidden
 * ────────────────
 * • PUBLIC  : submitter address, ciphertext blob, submission order, deadline,
 *             reward, TEE attestation report, final winner.
 * • HIDDEN  : plaintext answer (until AI judging inside TEE), AI prompt
 *             contents, scoring rubric weights.
 * • TEE-decided : winner (TEE returns index; humans cannot tamper).
 * • HUMAN-decided : bounty lifecycle parameters (deadline, reward, rubric).
 */
contract RitualHiddenBounty is PrivacyBountyJudge {
    // ---------------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------------

    /// @notice Per-bounty list of encrypted submissions.
    struct EncryptedSubmission {
        address submitter;
        bytes ciphertext;
        bool delivered;
    }

    mapping(uint256 => EncryptedSubmission[]) internal _encrypted;
    mapping(uint256 => bytes) public tAttestationReports; // bountyId → TEE report
    mapping(uint256 => uint256) public tWinnerIndex;      // bountyId → winner

    /// @notice Expose the parent struct for callers + subclass convenience.
    function _bounty(uint256 id) internal view returns (PrivacyBountyJudge.Bounty storage) {
        return bounties[id];
    }

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    event SecretSubmitted(
        uint256 indexed bountyId,
        uint256 indexed index,
        address indexed submitter
    );

    event JudgingRequested(uint256 indexed bountyId, bytes teeInput);
    event TEEJudgingCompleted(uint256 indexed bountyId, bytes attestation, uint256 winnerIndex);

    // ---------------------------------------------------------------------
    // External API
    // ---------------------------------------------------------------------

    /// @notice Submit an encrypted answer. Caller is responsible for ECIES-
    ///         encrypting `(answer, salt, msg.sender, bountyId)` under the
    ///         TEE's secp256k1 pubkey (use `getAgentPubKey` to fetch).
    function submitSecret(uint256 bountyId, bytes calldata ciphertext) external {
        // Re-use the commit-reveal open-phase semantics: deadline + phase Open.
        require(
            block.timestamp < bounties[bountyId].deadline,
            "submissions closed"
        );
        require(bounties[bountyId].owner != address(0), "bounty not found");
        require(bounties[bountyId].phase == PrivacyBountyJudge.Phase.Open, "wrong phase");
        require(ciphertext.length >= 32 + 12 + 16, "ciphertext too short");
        require(
            _commitmentIndexPlusOne[bountyId][msg.sender] == 0,
            "already submitted"
        );

        _encrypted[bountyId].push(
            EncryptedSubmission({
                submitter: msg.sender,
                ciphertext: ciphertext,
                delivered: false
            })
        );

        // Track via the parent contract's commitment map so the reveal path
        // remains consistent. We store a dummy bytes32 so the bookkeeping
        // (one-entry-per-submitter) holds.
        bounties[bountyId].commitments.push(
            PrivacyBountyJudge.Commitment({
                submitter: msg.sender,
                commitment: keccak256(ciphertext), // privacy-preserving pointer
                revealed: false,
                refunded: false
            })
        );
        _commitmentIndexPlusOne[bountyId][msg.sender] = _encrypted[bountyId].length;

        emit SecretSubmitted(bountyId, _encrypted[bountyId].length - 1, msg.sender);
    }

    /// @notice Owner-only: hand the bundle of ciphertexts to the Sovereign
    ///         Agent precompile. The TEE decrypts, judges, and writes back
    ///         `tWinnerIndex` via the async delivery callback.
    function requestJudging(uint256 bountyId) external {
        PrivacyBountyJudge.Bounty storage b = bounties[bountyId];
        require(b.owner == msg.sender, "not bounty owner");
        require(block.timestamp >= b.deadline, "deadline not reached");
        require(b.phase == PrivacyBountyJudge.Phase.Open, "wrong phase");
        require(_encrypted[bountyId].length > 0, "no submissions");

        // Encode the ciphertext bundle as precompile input. The exact ABI is
        // defined by the Sovereign Agent runtime; see ritual-dapp-agents
        // skill ("Sovereign agent JSON-RPC interface").
        bytes memory payload = abi.encode(
            bountyId,
            b.rubric,
            _encrypted[bountyId]
        );

        _executePrecompile(SOVEREIGN_AGENT_PRECOMPILE, payload);

        b.phase = PrivacyBountyJudge.Phase.Reveal;
        emit JudgingRequested(bountyId, payload);
    }

    /// @notice Callback entry point used by the async delivery system after
    ///         the TEE completes judging. Restricted to the AsyncDelivery
    ///         system contract so only the TEE pipeline can write the result.
    function deliverResult(uint256 bountyId, bytes calldata attestation, uint256 winnerIndex) external {
        require(msg.sender == ASYNC_DELIVERY, "only async delivery");
        require(winnerIndex < _encrypted[bountyId].length, "invalid winner");

        tAttestationReports[bountyId] = attestation;
        tWinnerIndex[bountyId] = winnerIndex;

        // Mark the encrypted submissions as delivered so they can't be reused.
        uint256 len = _encrypted[bountyId].length;
        for (uint256 i = 0; i < len; i++) {
            _encrypted[bountyId][i].delivered = true;
        }

        PrivacyBountyJudge.Bounty storage b = bounties[bountyId];
        b.phase = PrivacyBountyJudge.Phase.Judged;
        b.aiReview = attestation;
        b.winnerIndex = winnerIndex;

        emit TEEJudgingCompleted(bountyId, attestation, winnerIndex);
    }

    /// @notice Owner-only: finalize the TEE-reported winner. Identical reward
    ///         distribution semantics as `PrivacyBountyJudge.finalizeWinner`.
    function finalizeTEEWinner(uint256 bountyId) external {
        PrivacyBountyJudge.Bounty storage b = bounties[bountyId];
        require(b.owner == msg.sender, "not bounty owner");
        require(b.phase == PrivacyBountyJudge.Phase.Judged, "not judged");
        uint256 winnerIdx = tWinnerIndex[bountyId];
        require(winnerIdx < _encrypted[bountyId].length, "no winner");

        b.phase = PrivacyBountyJudge.Phase.Finalized;

        address winner = _encrypted[bountyId][winnerIdx].submitter;
        uint256 reward = b.reward;
        b.reward = 0;

        (bool ok, ) = payable(winner).call{value: reward}("");
        require(ok, "payment failed");

        emit WinnerFinalized(bountyId, winnerIdx, winner, reward);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    function getEncryptedSubmissions(uint256 bountyId)
        external
        view
        returns (address[] memory submitters, bytes[] memory ciphertexts)
    {
        uint256 len = _encrypted[bountyId].length;
        submitters = new address[](len);
        ciphertexts = new bytes[](len);
        for (uint256 i = 0; i < len; i++) {
            submitters[i] = _encrypted[bountyId][i].submitter;
            ciphertexts[i] = _encrypted[bountyId][i].ciphertext;
        }
    }
}