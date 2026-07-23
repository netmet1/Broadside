import { HeartIcon } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useAppVersion } from "@/lib/useAppVersion";

/** Ko-fi donations page; funnels from the About dialog's Donate button. */
const DONATE_URL = "https://ko-fi.com/netmet";

/**
 * About dialog (D-019): version, donations link, NOTICE reference.
 * The Donate button opens DONATE_URL in the default browser via the
 * Tauri opener plugin.
 */
export function AboutDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const version = useAppVersion("unknown");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Broadside</DialogTitle>
          <DialogDescription>
            SSH broadcast console: one command, many hosts.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Version</span>
            <span className="font-mono text-xs">{version}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Support development</span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void openUrl(DONATE_URL)}
            >
              <HeartIcon />
              Donate
            </Button>
          </div>
          <p className="pt-1 text-xs text-muted-foreground">
            © 2026 netmet1. Free software under the GNU GPL v3.0; see
            LICENSE / NOTICE.md.
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
