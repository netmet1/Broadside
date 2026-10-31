import { HeartIcon } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { openDonatePage } from "@/lib/tauri/about";
import { useAppVersion } from "@/lib/useAppVersion";

/**
 * About dialog (D-019): version, donations link, NOTICE reference.
 * The Donate button asks the backend to open the donations page in the
 * default browser; the address lives there (`commands/about.rs`).
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
              onClick={() => void openDonatePage()}
            >
              <HeartIcon className="fill-red-500 text-red-500" />
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
