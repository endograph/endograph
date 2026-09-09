import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AnyAction } from "@projectors/core";
import type { Paths } from "../harness/paths.ts";
import type { HostActionDescriptor } from "./action.ts";
import { hostActionProxy, type HostClient } from "./client.ts";

export const hostCataloguePath = (paths: Paths) => join(paths.state, "host-actions.json");

/** Owner-side documentation reads schemas without constructing executable proxies. */
export function readHostCatalogue(paths: Paths): HostActionDescriptor[] {
  const descriptors = JSON.parse(readFileSync(hostCataloguePath(paths), "utf8"));
  if (!Array.isArray(descriptors)) throw new Error("host action catalogue must be an array");
  return descriptors;
}

/** Worker-side actions require a live, explicitly supplied host connection. */
export async function loadHostActions(paths: Paths, names: string[], client?: HostClient): Promise<AnyAction[]> {
  if (!names.length) return [];
  if (!client) throw new Error(`${paths.grant}: host actions require endo up or createAgentHost`);
  const descriptors = await client.describe();
  return names.map((name) => {
    const descriptor = descriptors.find((d) => d?.name === name);
    if (!descriptor) throw new Error(`${paths.grant}: host action "${name}" is not provided by this broker`);
    return hostActionProxy(descriptor, (action, args) => client.call(action, args));
  });
}
