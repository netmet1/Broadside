import { Loader2Icon, PlugIcon, ServerIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useHint } from "@/lib/status";
import { type useSftpBrowser } from "@/pages/sftp/useSftpBrowser";

/** Right pane before a host is connected: host picker + Connect. */
export function RemoteConnectPane({
  hosts,
  pickedHostId,
  setPickedHostId,
  connecting,
  onConnect,
}: {
  hosts: ReturnType<typeof useSftpBrowser>["hosts"];
  pickedHostId: string;
  setPickedHostId: (v: string) => void;
  connecting: boolean;
  onConnect: () => void;
}) {
  const hint = useHint();
  return (
    <div className="flex h-full min-w-0 flex-1 flex-col overflow-hidden rounded-lg border border-border/60 bg-muted/20">
      <div className="flex shrink-0 items-center gap-1.5 border-b border-border/50 px-3 py-2 text-sm font-medium">
        <ServerIcon className="h-4 w-4 text-muted-foreground" />
        Remote host
      </div>
      <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6">
        <p className="text-sm text-muted-foreground">
          Connect to a host to browse and transfer files.
        </p>
        <div className="flex items-center gap-2">
          <Select value={pickedHostId} onValueChange={setPickedHostId}>
            <SelectTrigger className="h-9 min-w-52" aria-label="Host">
              <SelectValue placeholder="Select a host…" />
            </SelectTrigger>
            <SelectContent>
              {hosts.map((h) => (
                <SelectItem key={h.id} value={String(h.id)}>
                  <span
                    className="h-2.5 w-2.5 shrink-0 rounded-full"
                    style={{ backgroundColor: h.color }}
                  />
                  {h.label} ({h.username}@{h.hostname}:{h.port})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            onClick={onConnect}
            disabled={!pickedHostId || connecting}
            {...hint("Open an SFTP session to the selected host")}
          >
            {connecting ? <Loader2Icon className="animate-spin" /> : <PlugIcon />}
            Connect
          </Button>
        </div>
        {hosts.length === 0 && (
          <span className="text-xs text-muted-foreground">
            No hosts configured. Add hosts on the Hosts page first.
          </span>
        )}
      </div>
    </div>
  );
}
