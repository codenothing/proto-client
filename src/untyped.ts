/* eslint-disable @typescript-eslint/no-explicit-any */
import type { ProtoRequest } from "./ProtoRequest";

// This file provides type backdoors for specific use cases

export type UntypedProtoRequest = ProtoRequest<any, any>;
