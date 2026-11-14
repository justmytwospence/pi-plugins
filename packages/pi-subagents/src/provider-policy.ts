import { type FamilyTable, type TableRoute, parentRoute } from "./model-families.ts";

export type { Tier } from "./model-families.ts";

/** The route a parent model sits on, from the shared family table. */
export interface ProviderPolicy {
  route: TableRoute;
  /** Key into built-in role profiles. */
  profileProvider: string;
}

/** No policy for an unknown provider or an unrecognized Google route. */
export function providerPolicy(parentModel: string, table: FamilyTable): ProviderPolicy | undefined {
  const slash = parentModel.indexOf("/");
  if (slash <= 0) return undefined;
  const route = parentRoute(table.routes, parentModel.slice(0, slash), parentModel.slice(slash + 1));
  return route ? { route, profileProvider: route.profileProvider } : undefined;
}
