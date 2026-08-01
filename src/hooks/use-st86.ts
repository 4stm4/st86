import { useSyncExternalStore } from "react";
import { getServerState, getState, subscribe } from "@/lib/st86-store";

export function useSt86() {
  return useSyncExternalStore(subscribe, getState, getServerState);
}
