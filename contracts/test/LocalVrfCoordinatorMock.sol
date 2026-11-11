// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {VRFV2PlusClient} from "../../.chainlink-deps/src/v0.8/vrf/dev/libraries/VRFV2PlusClient.sol";
interface ILocalCallback {function rawFulfillRandomWords(uint256,uint256[] calldata) external;}
/// TEST ONLY, authored mock. NO VRF proof verification, no real billing, NOT the official coordinator.
contract LocalVrfCoordinatorMock {
    uint256 public nextSubscription=1;uint256 public nextRequest=1;bool public rejectRequests;bool public duplicateIds;bool public malformedReturn;
    mapping(uint256=>uint256) public credits;mapping(uint256=>mapping(address=>bool)) public consumers;
    mapping(uint256=>address) public targets;mapping(uint256=>uint32) public gasLimits;
    mapping(uint256=>bytes32) public requestKeyHash;mapping(uint256=>uint16) public requestConfirmations;mapping(uint256=>bytes) public requestExtraArgs;
    function createSubscription() external returns(uint256){return nextSubscription++;}
    function fundSubscription(uint256 id,uint256 amount) external {credits[id]+=amount;}
    function addConsumer(uint256 id,address who) external {consumers[id][who]=true;}
    function setMalformed(bool on) external {malformedReturn=on;} // TEST ONLY
    function setCredits(uint256 id,uint256 amount) external {credits[id]=amount;} // TEST-ONLY fictional credits
    function controls(bool reject,bool duplicate) external {rejectRequests=reject;duplicateIds=duplicate;}
    function requestRandomWords(VRFV2PlusClient.RandomWordsRequest calldata r) external returns(uint256 id){
        if(malformedReturn){assembly {return(0,0)}}
        require(!rejectRequests && credits[r.subId]>0 && consumers[r.subId][msg.sender],"MOCK_UNFUNDED_OR_REJECTED");require(r.numWords==1,"MOCK_ONE_WORD");credits[r.subId]--;
        id=duplicateIds?1:nextRequest++;targets[id]=msg.sender;gasLimits[id]=r.callbackGasLimit;
        requestKeyHash[id]=r.keyHash;requestConfirmations[id]=r.requestConfirmations;requestExtraArgs[id]=r.extraArgs;
    }
    function fulfill(uint256 id,uint256 word) external {uint256[] memory w=new uint256[](1);w[0]=word;_send(id,targets[id],w);}
    function send(uint256 id,address to,uint256[] calldata words) external {_send(id,to,words);}
    function _send(uint256 id,address to,uint256[] memory words) internal {
        uint256 g=gasLimits[id];if(g==0)g=200000;
        (bool ok,)=to.call{gas:g}(abi.encodeCall(ILocalCallback.rawFulfillRandomWords,(id,words)));require(ok,"MOCK_CALLBACK_REVERTED");
    }
}
