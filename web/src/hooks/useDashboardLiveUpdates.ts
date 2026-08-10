import { useEffect, useRef } from "react";
import { API_BASE } from "../config";

type LiveChannel = {
  source: EventSource;
  subscribers: Set<() => void>;
  refreshTimer: number | null;
  refreshPendingWhileHidden: boolean;
  handleVisibility: () => void;
  scheduleRefresh: () => void;
};

const liveChannels = new Map<string, LiveChannel>();

function createLiveChannel(address: string): LiveChannel {
  const channel = {} as LiveChannel;
  channel.subscribers = new Set();
  channel.refreshTimer = null;
  channel.refreshPendingWhileHidden = false;
  channel.source = new EventSource(`${API_BASE}/live/dashboard?address=${encodeURIComponent(address)}`);
  channel.scheduleRefresh = () => {
    if (document.visibilityState === "hidden") {
      channel.refreshPendingWhileHidden = true;
      return;
    }
    if (channel.refreshTimer != null) window.clearTimeout(channel.refreshTimer);
    channel.refreshTimer = window.setTimeout(() => {
      channel.refreshTimer = null;
      for (const refresh of channel.subscribers) refresh();
    }, 600);
  };
  channel.handleVisibility = () => {
    if (document.visibilityState === "visible" && channel.refreshPendingWhileHidden) {
      channel.refreshPendingWhileHidden = false;
      channel.scheduleRefresh();
    }
  };
  channel.source.addEventListener("refresh", channel.scheduleRefresh);
  document.addEventListener("visibilitychange", channel.handleVisibility);
  return channel;
}

function releaseLiveChannel(address: string, channel: LiveChannel) {
  if (channel.subscribers.size > 0) return;
  if (channel.refreshTimer != null) window.clearTimeout(channel.refreshTimer);
  channel.source.removeEventListener("refresh", channel.scheduleRefresh);
  channel.source.close();
  document.removeEventListener("visibilitychange", channel.handleVisibility);
  liveChannels.delete(address);
}

export function useDashboardLiveUpdates(address: string, onRefresh: () => void): void {
  const refreshRef = useRef(onRefresh);
  refreshRef.current = onRefresh;

  useEffect(() => {
    if (!address || typeof EventSource === "undefined") return;
    const normalizedAddress = address.toLowerCase();
    const channel = liveChannels.get(normalizedAddress) || createLiveChannel(normalizedAddress);
    liveChannels.set(normalizedAddress, channel);
    const refresh = () => refreshRef.current();
    channel.subscribers.add(refresh);
    return () => {
      channel.subscribers.delete(refresh);
      releaseLiveChannel(normalizedAddress, channel);
    };
  }, [address]);
}
