// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IVRFCoordinatorV2Plus} from "../../.chainlink-deps/src/v0.8/vrf/dev/interfaces/IVRFCoordinatorV2Plus.sol";
import {VRFV2PlusClient} from "../../.chainlink-deps/src/v0.8/vrf/dev/libraries/VRFV2PlusClient.sol";

interface IDrawMarket {
    function drawRequestOpen(uint256 jobId, uint256 round) external view returns (bool);
    /// Public getter of the market's verifier registry: (bond, duties, indexPlus1, reserved).
    function verifiers(address v) external view returns (uint256 bond, uint32 duties, uint32 indexPlus1, uint256 reserved);
}

/// LOCAL PROTOTYPE: official VRF2.5 request ABI; custom immutable consumer authentication.
/// No owner/migration/configuration/funding/withdrawal powers. NOT a production-audited consumer.
/// Switching from the LOCAL SIMULATED coordinator to the official VRF 2.5 coordinator is a CONFIG change only
/// (coordinator address, subscriptionId, keyHash, confirmations, callbackGasLimit, nativePayment), see
/// helpers/vrf-config.cjs. Not connected: no subscription exists, no LINK, nothing deployed.
contract FrozenVrfDraw {
    struct Config { address coordinator; uint256 subscriptionId; bytes32 keyHash; uint16 confirmations; uint32 callbackGasLimit; bool nativePayment; }
    enum State { Empty, Pending, Ready, Consumed, Failed, Closed }
    struct Draw {
        State state; uint8 size; uint32 commitWindow; uint32 revealWindow;
        uint256 requestId; bytes32 snapshotHash; uint256 word;
        address[] candidates; uint256[] weights;
        // SATURATION FIX (N1): two separate locks.
        //  - listed: every frozen candidate counts one open list in `candidacy` (blocks EXIT only, no capacity);
        //  - hold:   penalty held ONLY on the SELECTED, set in the same tx that makes the result public (capacity).
        uint256 hold;   // penalty held on each selected seat while Ready (0 = nothing held / released)
        uint256 need;   // duty penalty fixed at open (applied to the selected at fulfillment)
        uint256 picks;  // selected candidate indexes, 8 bits each (count <= 200, size <= 15), fixed at fulfillment
        bool listed;    // candidacy counted for every candidate (request really sent) and not yet released
        // THREE-LIMITS FIX (3): bit i set = candidate i already released its exit-lock early (releaseCandidate),
        // allowed only once the result is public and i is NOT selected (or the draw failed / closed). count <= 200 < 256.
        uint256 freed;
    }
    struct Ref { uint256 jobId; uint256 round; bool exists; }
    address public immutable market;
    address public immutable coordinator;
    uint256 public immutable subscriptionId;
    bytes32 public immutable keyHash;
    uint16 public immutable confirmations;
    uint32 public immutable callbackGasLimit;
    bool public immutable nativePayment;
    bytes32 public constant DOMAIN = keccak256("SUPERION_FROZEN_VRF_DRAW_V1");
    mapping(uint256 => mapping(uint256 => Draw)) private _draws;
    mapping(uint256 => Ref) public requests;
    /// Per-verifier locks packed in ONE slot (the market's eligibility read of `frozenHold` warms the slot that
    /// `open` then increments: no extra cold SSTORE per candidate at the 200-candidate snapshot).
    ///  hold  = sum of penalties held on `who` as a SELECTED juror of a Ready draw (result public, jury not yet seated);
    ///          the market adds it to its own per-seat `reserved` before any exit, eligibility or seating decision.
    ///  count = number of open frozen lists `who` is a candidate on. Non-zero => the market refuses exitVerifier.
    ///          It does NOT count against eligibility for other draws (saturation fix N1).
    struct Lock { uint192 hold; uint64 count; }
    mapping(address => Lock) private _lock;
    function frozenHold(address who) external view returns (uint256) { return _lock[who].hold; }
    function candidacy(address who) external view returns (uint256) { return _lock[who].count; }
    error OnlyMarket(); error OnlyCoordinator(); error InvalidConfig(); error AlreadyOpened(); error NotReady(); error StillLocked();
    /// THREE-LIMITS FIX (1): skip budget of the selection run inside the VRF callback (was 10). Bounded so that the worst
    /// case (200 candidates, jury 15, every drawn candidate saturated) stays measured under the planned callback gas limit.
    uint256 public constant MAX_SKIPS = 40;
    event Snapshot(uint256 indexed jobId, uint256 indexed round, bytes32 snapshotHash, uint256 count, uint256 size);
    event Requested(uint256 indexed jobId, uint256 indexed round, uint256 requestId);
    event RequestFailed(uint256 indexed jobId, uint256 indexed round);
    event ResultStored(uint256 indexed requestId);
    event ResultIgnored(uint256 indexed requestId);

    constructor(Config memory c) {
        // Fail fast on a config that the official VRF 2.5 coordinator would never serve (zero key hash / zero subscription),
        // instead of silently sending every dispute to the Safe later. Coordinator must already have code on THIS chain.
        if(c.coordinator.code.length == 0 || c.keyHash == bytes32(0) || c.subscriptionId == 0 || c.callbackGasLimit < 100000 || c.callbackGasLimit > 2500000 || c.confirmations > 200) revert InvalidConfig();
        market=msg.sender; coordinator=c.coordinator; subscriptionId=c.subscriptionId; keyHash=c.keyHash;
        confirmations=c.confirmations; callbackGasLimit=c.callbackGasLimit; nativePayment=c.nativePayment;
    }
    modifier onlyMarket(){if(msg.sender!=market) revert OnlyMarket();_;}
    function open(uint256 jobId,uint256 round,address[] memory list,uint256[] memory weights,uint256 count,uint8 size,uint32 cw,uint32 rw,uint256 penalty) external onlyMarket {
        Draw storage d=_draws[jobId][round];if(d.state!=State.Empty) revert AlreadyOpened();
        if(count>200 || count>list.length || count>weights.length || size==0 || size>15 || penalty>type(uint192).max) revert InvalidConfig();
        d.state=State.Pending;d.size=size;d.commitWindow=cw;d.revealWindow=rw;
        // All user-significant inputs are fixed BEFORE the external request.
        for(uint256 i;i<count;++i){d.candidates.push(list[i]);d.weights.push(weights[i]);}
        d.snapshotHash=keccak256(abi.encode(DOMAIN,block.chainid,address(this),market,jobId,round,list,weights,count,size,cw,rw));
        emit Snapshot(jobId,round,d.snapshotHash,count,size);
        if(count<size){d.state=State.Failed;emit RequestFailed(jobId,round);return;}
        // Exactly one attempt: even a failed/unfunded request cannot be retried or cancelled for another result.
        bytes memory input=abi.encodeCall(IVRFCoordinatorV2Plus.requestRandomWords,(VRFV2PlusClient.RandomWordsRequest({
            keyHash:keyHash,subId:subscriptionId,requestConfirmations:confirmations,callbackGasLimit:callbackGasLimit,numWords:1,
            extraArgs:VRFV2PlusClient._argsToBytes(VRFV2PlusClient.ExtraArgsV1({nativePayment:nativePayment}))
        })));
        // A wrong-interface coordinator returning malformed data must not roll back filing either.
        (bool ok,bytes memory reply)=coordinator.call{gas:500000}(input);
        if(!ok || reply.length!=32){d.state=State.Failed;emit RequestFailed(jobId,round);return;}
        uint256 id=abi.decode(reply,(uint256));
        if(requests[id].exists){d.state=State.Failed;emit RequestFailed(jobId,round);return;}
        requests[id]=Ref(jobId,round,true);d.requestId=id;emit Requested(jobId,round,id);
        // Request really sent: every frozen candidate is EXIT-locked (candidacy), whatever the penalty, so nobody
        // who learns the result can leave. No capacity is consumed here: tiny disputes cannot saturate the pool.
        // The penalty is held on the SELECTED only, atomically with the result (rawFulfillRandomWords).
        d.need=penalty;d.listed=true;for(uint256 i;i<count;++i)++_lock[list[i]].count;
    }
    function _release(Draw storage d) private {
        uint256 h=d.hold;
        if(h!=0){d.hold=0;uint256 p=d.picks;for(uint256 t;t<d.size;++t)_lock[d.candidates[(p>>(8*t))&0xff]].hold-=uint192(h);}
        if(d.listed){d.listed=false;uint256 fr=d.freed;for(uint256 i;i<d.candidates.length;++i)if((fr>>i)&1==0)--_lock[d.candidates[i]].count;}
    }
    /// Weighted draw without replacement from the frozen snapshot, run ONCE, in the fulfillment transaction.
    /// A drawn candidate that cannot carry this duty's penalty AT THIS MOMENT (already selected/seated elsewhere
    /// up to its bond, or removed from the registry by a slash) is skipped with fresh deterministic randomness.
    /// Nobody can react between the result becoming public and this check: they are the same transaction.
    /// Without any skip, the selection is exactly the previous pick() algorithm (randomness index n == seat t).
    function _select(uint256 jobId,uint256 round,Draw storage d) private view returns(bool ok,uint256 picks){
        uint256[] memory w=d.weights;uint256 len=w.length;uint256 total;
        for(uint256 i;i<len;++i)total+=w[i];
        bytes32 seed=keccak256(abi.encode(DOMAIN,block.chainid,address(this),market,jobId,round,d.requestId,d.snapshotHash,d.word));
        uint256 need=d.need;uint256 size=d.size;address mkt=market;uint256 n;
        // Bounded work for the VRF callback gas limit: at most size+MAX_SKIPS draws in total, else Failed (Safe path).
        // THREE-LIMITS FIX (1): same draw sequence as before (randomness index n, weighted scan, no replacement), but the
        // loop body allocates no memory (scratch-space hashing, reused call buffer), so a skip is ~3x cheaper and the
        // skip budget can be 40 instead of 10 within the same planned callback gas limit.
        for(uint256 t;t<size;++n){
            if(total==0||n>=size+MAX_SKIPS)return(false,0);
            uint256 i;uint256 wi;
            assembly ("memory-safe") {
                mstore(0x00,seed) mstore(0x20,n)
                let r:=mod(keccak256(0x00,0x40),total)
                let p:=add(w,0x20)
                for {} lt(i,len) {i:=add(i,1)} { wi:=mload(add(p,shl(5,i))) if lt(r,wi) {break} r:=sub(r,wi) }
                mstore(add(p,shl(5,i)),0)
            }
            total-=wi;address v=d.candidates[i];uint256 bond;uint256 idx;uint256 reserved;
            assembly ("memory-safe") {
                let b:=mload(0x40)
                mstore(b,shl(224,0x6c824487)) mstore(add(b,4),v)
                if iszero(staticcall(gas(),mkt,b,0x24,b,0x80)) {revert(0,0)}
                if lt(returndatasize(),0x80) {revert(0,0)}
                bond:=mload(b) idx:=mload(add(b,0x40)) reserved:=mload(add(b,0x60))
            }
            if(idx==0||bond<reserved+_lock[v].hold+need)continue;
            picks|=i<<(8*t);++t;
        }
        ok=true;
    }
    /// THREE-LIMITS FIX (3): once the VRF result is PUBLIC (Ready) a candidate that was NOT selected (skips included) is
    /// released from this list's exit-lock; if the draw Failed or was Closed without a jury, every candidate is.
    /// Permissionless (it only ever frees a non-selected candidate; it moves no funds and changes no selection).
    /// Selected jurors stay locked (candidacy + held penalty) until seating or the unseated close, as before.
    /// Pending (result not public, possibly in the mempool) keeps everybody locked: fix (b) unchanged.
    function releaseCandidate(uint256 jobId,uint256 round,uint256 index) external {
        Draw storage d=_draws[jobId][round];State s=d.state;
        if(!d.listed||s==State.Pending||index>=d.candidates.length||(d.freed>>index)&1!=0) revert StillLocked();
        if(s==State.Ready){uint256 p=d.picks;for(uint256 t;t<d.size;++t)if((p>>(8*t))&0xff==index) revert StillLocked();}
        d.freed|=1<<index;--_lock[d.candidates[index]].count;
    }
    function heldPenalty(uint256 jobId,uint256 round) external view returns(uint256){return _draws[jobId][round].hold;}
    // Same documented callback selector as VRF2.5. Deliberately immutable coordinator,
    // rather than inheriting the standard consumer's owner/coordinator migration powers.
    function rawFulfillRandomWords(uint256 id,uint256[] calldata words) external {
        if(msg.sender!=coordinator) revert OnlyCoordinator();
        Ref memory r=requests[id];if(!r.exists){emit ResultIgnored(id);return;}
        Draw storage d=_draws[r.jobId][r.round];
        if(d.state!=State.Pending){emit ResultIgnored(id);return;}
        if(!IDrawMarket(market).drawRequestOpen(r.jobId,r.round)){d.state=State.Closed;emit ResultIgnored(id);return;}
        if(words.length!=1){d.state=State.Failed;emit ResultIgnored(id);return;}
        d.word=words[0];emit ResultStored(id);
        (bool ok,uint256 picks)=_select(r.jobId,r.round,d);
        if(!ok){d.state=State.Failed;emit RequestFailed(r.jobId,r.round);return;} // not enough capacity left: Safe path
        // Result public => the selected hold their penalty NOW (same tx). Their exit stays blocked by candidacy.
        d.picks=picks;d.state=State.Ready;uint256 h=d.need;
        if(h!=0){d.hold=h;for(uint256 t;t<d.size;++t)_lock[d.candidates[(picks>>(8*t))&0xff]].hold+=uint192(h);}
    }
    /// Selected jurors fixed by the result (empty before Ready). View for UIs/tests.
    function selection(uint256 jobId,uint256 round) external view returns(address[] memory s){
        Draw storage d=_draws[jobId][round];if(d.state!=State.Ready&&d.state!=State.Consumed)return s;
        s=new address[](d.size);for(uint256 t;t<d.size;++t)s[t]=d.candidates[(d.picks>>(8*t))&0xff];
    }
    function status(uint256 jobId,uint256 round) external view returns(State state,uint256 count,uint256 size,uint256 requestId,bytes32 snapshotHash,uint256 word){
        Draw storage d=_draws[jobId][round];return(d.state,d.candidates.length,d.size,d.requestId,d.snapshotHash,d.word);
    }
    function population(uint256 jobId,uint256 round) external view returns(address[] memory,uint256[] memory){Draw storage d=_draws[jobId][round];return(d.candidates,d.weights);}
    function pick(uint256 jobId,uint256 round) external onlyMarket returns(address[] memory selected,uint256[] memory coverage,uint32 cw,uint32 rw){
        Draw storage d=_draws[jobId][round];if(d.state!=State.Ready) revert NotReady();d.state=State.Consumed;
        selected=new address[](d.size);coverage=new uint256[](d.size);uint256 p=d.picks;
        for(uint256 t;t<d.size;++t){uint256 i=(p>>(8*t))&0xff;selected[t]=d.candidates[i];coverage[t]=d.weights[i];}
        _release(d); // the market re-reserves the penalty on the SELECTED seats in the same transaction
        return(selected,coverage,d.commitWindow,d.revealWindow);
    }
    function close(uint256 jobId,uint256 round) external onlyMarket {
        Draw storage d=_draws[jobId][round];if(d.state!=State.Consumed && d.state!=State.Empty)d.state=State.Closed;
        _release(d); // unseated close (Pending / Ready / Failed / late-Closed): release selected holds + list once
    }
}
