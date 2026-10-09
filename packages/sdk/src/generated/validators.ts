// GENERATED from core/src/protocol/protocol.schema.json. Do not edit.
import * as validators from './compiled.js';
import { assertJson, ProtocolError } from './validation.js';
export type WireName = "PostDocument" | "PublishRequest" | "ConnectRequest" | "StatusRequest" | "ConnectResult" | "PreparedResult" | "ExecutionResult" | "OperationView" | "StatusResultMap" | "ProviderWriteOutcome" | "FrozenProviderPayload" | "Envelope" | "StatusResult" | "ProviderConnectResult" | "VerifiedIdentity";
export function validateWire(name:WireName,value:unknown,response=false):void {
 assertJson(value,response?1048576:name==='FrozenProviderPayload'?262144:65536);
 const validate=validators[(response?'response':'request')+name as keyof typeof validators];
 if(!validate(value))throw new ProtocolError('INVALID_INPUT');
}
