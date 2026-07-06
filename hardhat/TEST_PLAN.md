# Test Plan — Privacy Bounty Judge

This plan enumerates every test case we ship, what invariant each one protects, and how to reproduce it. The contract under test is split between `PrivacyBountyJudge` (Required Track) and `RitualHiddenBounty` (Advanced Track).

## Conventions

- Each case ID has a prefix: `R-NN` for Required Track, `A-NN` for Advanced Track.
- Every revert case asserts on the **reason string** so silent behavior changes break the test.
- Every happy-path case asserts on **observable state** (storage + events + balance change).
- Time is manipulated via Hardhat's `evm_increaseTime` + `evm_mine` (no real waiting).

---

## Required Track — `PrivacyBountyJudge`

| ID | Case | Setup | Action | Expected |
|---|---|---|---|---|
| R-01 | Happy path — full lifecycle | 3 submitters, future deadline | submit×3 → time-warp → reveal×3 → judgeAll → finalizeWinner(1) | bounty summary: count=3, revealed=3, winner=1, reward paid to submitter 2 |
| R-02 | Reveal hash mismatch | 1 submitter, commitment built from `(real, salt)` | reveal with `(fake, salt)` | revert `hash mismatch` |
| R-03 | Double reveal | 1 submitter, valid `(answer, salt)` | reveal twice | first succeeds, second reverts `already revealed` |
| R-04 | Duplicate submitter | 1 submitter, 2 different commitments | submit twice | first succeeds, second reverts `already committed` |
| R-05 | Reveal before deadline | 1 submitter, future deadline | reveal immediately | revert `reveal not open` |
| R-06 | Reveal after judge | 1 submitter, full lifecycle to Judged | reveal after `judgeAll` | revert `too late` |
| R-07 | Judge with zero reveals | bounty created, no submits | `judgeAll` | revert `no revealed answers` |
| R-08 | Finalize before judge | bounty created, no judge | `finalizeWinner` | revert `not judged yet` |
| R-09 | Finalize with invalid index | bounty fully judged | `finalizeWinner(99)` | revert `invalid winner index` |
| R-10 | Cross-submitter binding | 2 submitters, same `(answer, salt)` | compare commitments | commitments differ |
| R-11 | Cross-bounty binding | 1 submitter, same `(answer, salt)`, 2 bounties | compare commitments | commitments differ |
| R-12 | Non-owner judge | bounty created by owner | `judgeAll` from non-owner | revert `not bounty owner` |
| R-13 | Max submissions cap | push MAX_SUBMISSIONS commitments | push 51st | revert `too many submissions` |
| R-14 | Max answer length cap | 4001-byte answer | reveal | revert `answer too long` |
| R-15 | Empty commitment | bytes32(0) | submit | revert `empty commitment` |
| R-16 | Deadline must be future | `createBounty` with past deadline | — | revert `deadline must be future` |
| R-17 | Reward required | `createBounty` with `msg.value=0` | — | revert `reward required` |
| R-18 | One-time owner payout | bounty finalized | read `bounty.reward` | returns 0; second `finalizeWinner` reverts `wrong phase` |
| R-19 | Phase auto-transition | `submitCommitment` after deadline in same block | — | phase auto-advances to `Reveal` |
| R-20 | Gas: `submitCommitment` ≤ 120k | profile | — | regression sentinel |

## Advanced Track — `RitualHiddenBounty`

| ID | Case | Setup | Action | Expected |
|---|---|---|---|---|
| A-01 | Submit ciphertext | 1 submitter, valid blob | `submitSecret` | stored; ciphertext recoverable via `getEncryptedSubmissions` |
| A-02 | Multiple submitters | 2 submitters | both `submitSecret` | both stored, indexed |
| A-03 | Duplicate submitter | 1 submitter | `submitSecret` twice | second reverts `already submitted` |
| A-04 | `requestJudging` before deadline | 1 submitter | `requestJudging` | revert `deadline not reached` |
| A-05 | `requestJudging` non-owner | 1 submitter, time-warpped | from non-owner | revert `not bounty owner` |
| A-06 | Ciphertext too short | < 32 + 12 + 16 bytes | `submitSecret` | revert `ciphertext too short` |
| A-07 | `deliverResult` only AsyncDelivery | impersonate random EOA | `deliverResult` | revert `only async delivery` |
| A-08 | `finalizeTEEWinner` before Judged | bounty created | `finalizeTEEWinner` | revert `not judged` |
| A-09 | `deliverResult` invalid winner | impersonate AsyncDelivery | `deliverResult(99)` | revert `invalid winner` |
| A-10 | Plaintext never on-chain | submit `0xC0FFEE`-style plaintext | inspect tx receipt + storage | no occurrence of plaintext in logs or storage |
| A-11 | TEE marks submissions delivered | impersonate AsyncDelivery, valid winner | `deliverResult(0)` | all `encrypted[i].delivered == true` |
| A-12 | Finalize pays winner | impersonate AsyncDelivery + owner | full pipeline | winner balance increases by `reward` |
| A-13 | ECIES nonce length = 12 (off-chain recipe) | local script | encrypt + decrypt | roundtrip succeeds; nonce=16 would fail decryption |
| A-14 | Gas: `submitSecret` ≤ 90k | profile | — | regression sentinel |

---

## Reproducing

```bash
cd hardhat
pnpm install
pnpm hardhat test test/PrivacyBountyJudge.test.ts
pnpm hardhat test test/RitualHiddenBounty.test.ts
```

Expected output: `passing` for every case listed above. A failure on any case should be treated as a security regression and reverted — the contracts are deliberately minimal so that any behavior change is easy to spot in the diff.

---

## Why these particular cases?

- **Binding tests (R-10, R-11)** are the single most important class — without them the contract degenerates to "store any commitment you want" and the commit-reveal flow becomes worthless.
- **`A-10` (plaintext never on-chain)** is the property the entire Advanced Track is built around. If this test ever fails, the whole advanced design is broken.
- **Phase-machine tests (R-06, R-08, R-19)** catch off-by-one errors in the state machine, which are the most common source of bounty-system exploits.