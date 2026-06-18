import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { HeartIcon } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

/**
 * About dialog (D-019): version, donations link slot, NOTICE reference.
 * The donations target gets wired when the repo flips public (GitHub
 * Sponsors requires a public repo) — until then the slot is a disabled
 * placeholder.
 */
export function AboutDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [version, setVersion] = useState("");

  useEffect(() => {
    getVersion().then(setVersion).catch(() => setVersion("unknown"));
  }, []);

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
            <Button variant="outline" size="sm" disabled title="Available once the project is public">
              <HeartIcon />
              Donate
            </Button>
          </div>
          <p className="pt-1 text-xs text-muted-foreground">
            © 2026 netmet1. All rights reserved. Proprietary software; see
            NOTICE.md for terms.
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
