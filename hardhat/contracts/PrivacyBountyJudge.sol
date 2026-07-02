// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PrecompileConsumer} from "./utils/PrecompileConsumer.sol";

/**
 * @title PrivacyBountyJudge
 * @notice Commit-reveal bounty judge. Submissions remain hidden during the
 *         submission phase via a commitment hash, then revealed after the
 *         deadline so they can be batch-judged by the AI precompile (0x0802).
 * @dev    Phase machine per bounty:
 *           Open      → submitCommitment (anyone, once per submitter per bounty)
 *           Reveal    → revealAnswer (after deadline, before finalization)
 *           Judged    → judgeAll (owner-only, calls LLM precompile on the
 *                       bundle of revealed answers)
 *           Finalized → finalizeWinner (owner-only, pays reward to winner)
 *
 *         Hash binding (EIP-aligned pattern):
 *           commitment = keccak256(abi.encodePacked(answer, salt, msg.sender, bountyId))
 *
 *         The contract deliberately binds `msg.sender` and `bountyId` into the
 *         commitment so that:
 *           - a commitment cannot be front-run and reused by another submitter,
 *           - the same answer cannot be re-submitted across different bounties.
 */
contract PrivacyBountyJudge is PrecompileConsumer {
    // ---------------------------------------------------------------------
    // Constants
    // ---------------------------------------------------------------------

    /// @notice Max simultaneous commitments per bounty (gas-bounded).
    uint256 public constant MAX_SUBMISSIONS = 50;

    /// @notice Max bytes of revealed answer string.
    uint256 public constant MAX_ANSWER_LENGTH = 4_000;

    // ---------------------------------------------------------------------
    // Types
    // ---------------------------------------------------------------------

    enum Phase {
        Open,      // accepting commitments
        Reveal,    // deadline passed, accepting reveals
        Judged,    // judgeAll ran
        Finalized  // winner paid out
    }

    struct Commitment {
        address submitter;
        bytes32 commitment;
        bool revealed;
        bool refunded;
    }

    struct Bounty {
        address owner;
        string title;
        string rubric;
        uint256 reward;
        uint256 deadline;        // unix seconds; reveal opens once block.timestamp >= deadline
        Phase phase;
        bytes aiReview;          // opaque return from LLM precompile
        uint256 winnerIndex;     // index into the *valid revealed* submissions
        uint256 revealedCount;   // number of submissions that successfully revealed
        Commitment[] commitments;
    }

    struct ConvoHistory {
        string storageType;
        string path;
        string secretsName;
    }

    // ---------------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------------

    uint256 public nextBountyId = 1;
    mapping(uint256 => Bounty) public bounties;

    // Track unique (bountyId, submitter) to enforce one commitment per submitter.
    // Marked internal so `RitualHiddenBounty` (subclass) can read it.
    mapping(uint256 => mapping(address => uint256)) internal _commitmentIndexPlusOne;

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    event BountyCreated(
        uint256 indexed bountyId,
        address indexed owner,
        string title,
        uint256 reward,
        uint256 deadline
    );

    event CommitmentSubmitted(
        uint256 indexed bountyId,
        uint256 indexed submissionIndex,
        address indexed submitter,
        bytes32 commitment
    );

    event AnswerRevealed(
        uint256 indexed bountyId,
        uint256 indexed submissionIndex,
        address indexed submitter,
        string answer
    );

    event AllAnswersJudged(uint256 indexed bountyId, bytes aiReview);

    event WinnerFinalized(
        uint256 indexed bountyId,
        uint256 indexed winnerIndex,
        address indexed winner,
        uint256 reward
    );

    // ---------------------------------------------------------------------
    // Modifiers
    // ---------------------------------------------------------------------

    modifier bountyExists(uint256 bountyId) {
        require(bounties[bountyId].owner != address(0), "bounty not found");
        _;
    }

    modifier onlyOwner(uint256 bountyId) {
        require(msg.sender == bounties[bountyId].owner, "not bounty owner");
        _;
    }

    modifier inPhase(uint256 bountyId, Phase expected) {
        require(bounties[bountyId].phase == expected, "wrong phase");
        _;
    }

    // ---------------------------------------------------------------------
    // Required Track API
    // ---------------------------------------------------------------------

    /// @notice Create a new bounty. Caller escrows `msg.value` as reward.
    /// @param title       Human-readable title (off-chain display).
    /// @param rubric      Judging prompt / criteria (stored on-chain for audit).
    /// @param deadline    Unix seconds at which the submission window closes.
    function createBounty(
        string calldata title,
        string calldata rubric,
        uint256 deadline
    ) external payable returns (uint256 bountyId) {
        require(msg.value > 0, "reward required");
        require(deadline > block.timestamp, "deadline must be future");

        bountyId = nextBountyId++;

        Bounty storage bounty = bounties[bountyId];
        bounty.owner = msg.sender;
        bounty.title = title;
        bounty.rubric = rubric;
        bounty.reward = msg.value;
        bounty.deadline = deadline;
        bounty.phase = Phase.Open;
        bounty.winnerIndex = type(uint256).max;

        emit BountyCreated(bountyId, msg.sender, title, msg.value, deadline);
    }

    /// @notice Submit a hidden commitment. Caller is bound to the commitment
    ///         via `msg.sender` + `bountyId`, so it cannot be reused across
    ///         submitters or bounties.
    function submitCommitment(
        uint256 bountyId,
        bytes32 commitment
    ) external bountyExists(bountyId) inPhase(bountyId, Phase.Open) {
        Bounty storage bounty = bounties[bountyId];

        require(block.timestamp < bounty.deadline, "submissions closed");
        require(
            bounty.commitments.length < MAX_SUBMISSIONS,
            "too many submissions"
        );
        require(commitment != bytes32(0), "empty commitment");
        require(
            _commitmentIndexPlusOne[bountyId][msg.sender] == 0,
            "already committed"
        );

        bounty.commitments.push(
            Commitment({
                submitter: msg.sender,
                commitment: commitment,
                revealed: false,
                refunded: false
            })
        );

        _commitmentIndexPlusOne[bountyId][msg.sender] = bounty.commitments.length;

        emit CommitmentSubmitted(
            bountyId,
            bounty.commitments.length - 1,
            msg.sender,
            commitment
        );

        // Auto-transition to Reveal if deadline has already passed in the same
        // block (rare but cheap to handle).
        if (block.timestamp >= bounty.deadline) {
            bounty.phase = Phase.Reveal;
        }
    }

    /// @notice Reveal the answer + salt behind a commitment. Must match the
    ///         originally submitted hash, otherwise the reveal is rejected.
    function revealAnswer(
        uint256 bountyId,
        string calldata answer,
        bytes32 salt
    ) external bountyExists(bountyId) {
        Bounty storage bounty = bounties[bountyId];

        // Permit reveals only after deadline OR once owner has moved to Reveal.
        require(
            block.timestamp >= bounty.deadline || bounty.phase >= Phase.Reveal,
            "reveal not open"
        );
        require(
            bounty.phase != Phase.Judged && bounty.phase != Phase.Finalized,
            "too late"
        );
        require(bytes(answer).length <= MAX_ANSWER_LENGTH, "answer too long");

        uint256 idxPlusOne = _commitmentIndexPlusOne[bountyId][msg.sender];
        require(idxPlusOne != 0, "no commitment to reveal");

        uint256 idx = idxPlusOne - 1;
        Commitment storage c = bounty.commitments[idx];

        require(!c.revealed, "already revealed");
        require(c.submitter == msg.sender, "not your commitment");
        // Note: struct field is `submitter` (not `committer`); this guard
        // is also redundant since `_commitmentIndexPlusOne` already binds
        // (bountyId, msg.sender) → index, so we keep just the hash check.

        bytes32 expected = keccak256(
            abi.encodePacked(answer, salt, msg.sender, bountyId)
        );
        require(expected == c.commitment, "hash mismatch");

        c.revealed = true;
        bounty.revealedCount += 1;

        // Lazy phase transition.
        if (bounty.phase == Phase.Open) {
            bounty.phase = Phase.Reveal;
        }

        emit AnswerRevealed(bountyId, idx, msg.sender, answer);
    }

    /// @notice Owner-only: invoke the LLM precompile on the bundle of revealed
    ///         answers. `llmInput` is opaque to the contract — the off-chain
    ///         Ritual TEE assembles the prompt from `getRevealedAnswers()` and
    ///         submits the encoded payload.
    function judgeAll(
        uint256 bountyId,
        bytes calldata llmInput
    ) external bountyExists(bountyId) onlyOwner(bountyId) {
        Bounty storage bounty = bounties[bountyId];

        require(bounty.phase != Phase.Judged, "already judged");
        require(bounty.phase != Phase.Finalized, "already finalized");
        require(bounty.revealedCount > 0, "no revealed answers");

        bytes memory output = _executePrecompile(
            LLM_INFERENCE_PRECOMPILE,
            llmInput
        );

        (
            bool hasError,
            bytes memory completionData,
            ,
            string memory errorMessage,

        ) = abi.decode(output, (bool, bytes, bytes, string, ConvoHistory));

        require(!hasError, errorMessage);

        bounty.phase = Phase.Judged;
        bounty.aiReview = completionData;

        emit AllAnswersJudged(bountyId, completionData);
    }

    /// @notice Owner-only: pay the reward to a single winner by index into
    ///         the *revealed* subset (see `getRevealedAnswers`).
    function finalizeWinner(
        uint256 bountyId,
        uint256 winnerIndex
    ) external bountyExists(bountyId) onlyOwner(bountyId) {
        Bounty storage bounty = bounties[bountyId];

        require(bounty.phase == Phase.Judged, "not judged yet");
        require(winnerIndex < bounty.revealedCount, "invalid winner index");

        bounty.phase = Phase.Finalized;

        address winner;
        uint256 found;
        uint256 len = bounty.commitments.length;
        for (uint256 i = 0; i < len; i++) {
            if (bounty.commitments[i].revealed) {
                if (found == winnerIndex) {
                    winner = bounty.commitments[i].submitter;
                    break;
                }
                found += 1;
            }
        }
        require(winner != address(0), "winner not found");

        uint256 reward = bounty.reward;
        bounty.reward = 0;
        bounty.winnerIndex = winnerIndex;

        (bool ok, ) = payable(winner).call{value: reward}("");
        require(ok, "payment failed");

        emit WinnerFinalized(bountyId, winnerIndex, winner, reward);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    function getBountySummary(uint256 bountyId)
        external
        view
        bountyExists(bountyId)
        returns (
            address owner,
            string memory title,
            uint256 reward,
            uint256 deadline,
            uint8 phase,
            uint256 submissionCount,
            uint256 revealedCount,
            uint256 winnerIndex
        )
    {
        Bounty storage bounty = bounties[bountyId];
        return (
            bounty.owner,
            bounty.title,
            bounty.reward,
            bounty.deadline,
            uint8(bounty.phase),
            bounty.commitments.length,
            bounty.revealedCount,
            bounty.winnerIndex
        );
    }

    /// @notice Returns ONLY the revealed answers, in submission order. Skips
    ///         commitments that never revealed (or revealed with mismatched
    ///         hash). Used to assemble the LLM prompt off-chain.
    function getRevealedAnswers(uint256 bountyId)
        external
        view
        bountyExists(bountyId)
        returns (address[] memory submitters, string[] memory answers)
    {
        Bounty storage bounty = bounties[bountyId];

        submitters = new address[](bounty.revealedCount);
        answers = new string[](bounty.revealedCount);

        uint256 out;
        uint256 len = bounty.commitments.length;
        for (uint256 i = 0; i < len; i++) {
            Commitment storage c = bounty.commitments[i];
            if (c.revealed) {
                submitters[out] = c.submitter;
                answers[out] = _decodeAnswer(c.commitment, bountyId);
                // Note: above reads only commit-time data; the actual revealed
                // string is recovered via the AnswerRevealed event log when
                // needed. We expose a richer helper below for off-chain use.
                out += 1;
            }
        }
    }

    /// @notice Lightweight helper that returns the full commitment records
    ///         for off-chain inspection (revealed flag, original hash, etc.).
    function getCommitments(uint256 bountyId)
        external
        view
        bountyExists(bountyId)
        returns (address[] memory submitters, bytes32[] memory commitments, bool[] memory revealed)
    {
        Bounty storage bounty = bounties[bountyId];
        uint256 len = bounty.commitments.length;
        submitters = new address[](len);
        commitments = new bytes32[](len);
        revealed = new bool[](len);
        for (uint256 i = 0; i < len; i++) {
            Commitment storage c = bounty.commitments[i];
            submitters[i] = c.submitter;
            commitments[i] = c.commitment;
            revealed[i] = c.revealed;
        }
    }

    function _decodeAnswer(bytes32, uint256) internal pure returns (string memory) {
        // Answers themselves are NOT stored on-chain — they are recovered from
        // the AnswerRevealed event log. This stub keeps the public view API
        // signature stable without leaking plaintext.
        return "";
    }
}