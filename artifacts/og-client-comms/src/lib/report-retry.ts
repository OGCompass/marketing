import { queryOptions, type QueryKey } from "@tanstack/react-query";
import { discoverFubFields, getDiscoverFubFieldsMutationOptions } from "@workspace/api-client-react";
import { AccessCooldown, accessRetryDelay, shouldRetryAccess } from "./access-retry";

// Report scheduling is independent of the access check. Neither stores grants.
const cooldowns = new WeakMap<object, Map<string, AccessCooldown>>();

export function getReportCooldown(client: object, userId: string): AccessCooldown {
  let users = cooldowns.get(client);
  if (!users) {
    users = new Map();
    cooldowns.set(client, users);
  }
  let cooldown = users.get(userId);
  if (!cooldown) {
    cooldown = new AccessCooldown();
    users.set(userId, cooldown);
  }
  return cooldown;
}

export function reportQueryOptions<T>(
  cooldown: AccessCooldown,
  queryKey: QueryKey,
  request: (signal: AbortSignal) => Promise<T>,
  enabled: boolean,
) {
  return queryOptions({
    queryKey,
    enabled,
    queryFn: ({ signal }) => cooldown.run(() => request(signal), signal),
    // The same temporary HTTP/network policy applies to read-only reports.
    retry: shouldRetryAccess,
    retryDelay: accessRetryDelay,
  });
}

export function reportDiscoveryOptions(cooldown: AccessCooldown) {
  return getDiscoverFubFieldsMutationOptions({
    mutation: {
      // A failed POST may already have run. Only a confirmed user action retries.
      retry: false,
      mutationFn: ({ data }) => cooldown.run(() => discoverFubFields(data)),
    },
  });
}