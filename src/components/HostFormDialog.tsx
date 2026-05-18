import { useEffect } from "react";
import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  type Host,
  type HostInput,
  createHost,
  updateHost,
  errorMessage,
} from "@/lib/tauri/hosts";
import { PALETTE } from "@/lib/palette";

const FLAVOR_OPTIONS = [
  { value: "__none__", label: "(none)" },
  { value: "ubuntu", label: "Ubuntu" },
  { value: "debian", label: "Debian" },
  { value: "rhel", label: "RHEL" },
  { value: "fedora", label: "Fedora" },
  { value: "alpine", label: "Alpine" },
  { value: "arch", label: "Arch" },
  { value: "suse", label: "SUSE" },
  { value: "other", label: "Other" },
];

function isValidIPv4(s: string): boolean {
  const parts = s.split(".");
  if (parts.length !== 4) return false;
  return parts.every((p) => {
    if (!/^\d+$/.test(p)) return false;
    if (p.length > 1 && p.startsWith("0")) return false;
    const n = Number(p);
    return n >= 0 && n <= 255;
  });
}

function isValidIPv6(s: string): boolean {
  if (!s.includes(":")) return false;
  if ((s.match(/::/g) ?? []).length > 1) return false;
  const groups = s.split(":");
  // Allow empty groups only as part of a single "::" elision
  const hasElision = s.includes("::");
  const nonEmpty = groups.filter((g) => g !== "");
  if (!hasElision && groups.length !== 8) return false;
  if (hasElision && nonEmpty.length > 7) return false;
  return nonEmpty.every((g) => /^[0-9a-fA-F]{1,4}$/.test(g));
}

function isValidHostname(s: string): boolean {
  if (s.length === 0 || s.length > 253) return false;
  const labels = s.split(".");
  const labelRe = /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/;
  return labels.every((l) => l.length >= 1 && l.length <= 63 && labelRe.test(l));
}

function isValidHostnameOrIP(s: string): boolean {
  if (/^[\d.]+$/.test(s)) return isValidIPv4(s);
  if (s.includes(":")) return isValidIPv6(s);
  return isValidHostname(s);
}

const formSchema = z.object({
  label: z.string().trim().min(1, "Required"),
  hostname: z
    .string()
    .trim()
    .min(1, "Required")
    .refine(isValidHostnameOrIP, "Not a valid hostname or IP address"),
  port: z.number().int().min(1, "1-65535").max(65535, "1-65535"),
  username: z.string().trim().min(1, "Required"),
  color: z.string().regex(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, "Hex color like #3b82f6"),
  linux_flavor: z.string(),
  notes: z.string(),
});

type FormValues = z.infer<typeof formSchema>;

function emptyValues(defaultColor: string): FormValues {
  return {
    label: "",
    hostname: "",
    port: 22,
    username: "",
    color: defaultColor,
    linux_flavor: "__none__",
    notes: "",
  };
}

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  host: Host | null;
  defaultColor: string;
  onSaved: () => void;
};

export function HostFormDialog({
  open,
  onOpenChange,
  host,
  defaultColor,
  onSaved,
}: Props) {
  const isEdit = host !== null;
  const {
    register,
    handleSubmit,
    control,
    reset,
    watch,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: emptyValues(defaultColor),
  });

  useEffect(() => {
    if (!open) return;
    if (host) {
      reset({
        label: host.label,
        hostname: host.hostname,
        port: host.port,
        username: host.username,
        color: host.color,
        linux_flavor: host.linux_flavor ?? "__none__",
        notes: host.notes ?? "",
      });
    } else {
      reset(emptyValues(defaultColor));
    }
  }, [open, host, defaultColor, reset]);

  const selectedColor = watch("color");

  const onSubmit = handleSubmit(async (data) => {
    const input: HostInput = {
      label: data.label.trim(),
      hostname: data.hostname.trim(),
      port: data.port,
      username: data.username.trim(),
      color: data.color,
      linux_flavor: data.linux_flavor === "__none__" ? null : data.linux_flavor,
      notes: data.notes.trim() === "" ? null : data.notes.trim(),
    };
    try {
      if (host) {
        await updateHost(host.id, input);
        toast.success(`Updated ${input.label}`);
      } else {
        await createHost(input);
        toast.success(`Created ${input.label}`);
      }
      onSaved();
      onOpenChange(false);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit host" : "Add host"}</DialogTitle>
          <DialogDescription>
            {isEdit
              ? "Modify the connection details."
              : "Define a new SSH connection target. Credentials are added separately."}
          </DialogDescription>
        </DialogHeader>
        <form id="host-form" onSubmit={onSubmit} className="grid gap-3">
          <div className="grid gap-1">
            <Label htmlFor="label">Label</Label>
            <Input id="label" {...register("label")} placeholder="web-01" autoFocus />
            {errors.label?.message && (
              <p className="text-xs text-destructive">{errors.label.message}</p>
            )}
          </div>
          <div className="grid grid-cols-[1fr_auto] gap-2">
            <div className="grid gap-1">
              <Label htmlFor="hostname">Hostname</Label>
              <Input
                id="hostname"
                {...register("hostname")}
                placeholder="web01.example.com"
              />
              {errors.hostname?.message && (
                <p className="text-xs text-destructive">{errors.hostname.message}</p>
              )}
            </div>
            <div className="grid gap-1">
              <Label htmlFor="port">Port</Label>
              <Input
                id="port"
                type="number"
                className="w-24"
                {...register("port", { valueAsNumber: true })}
              />
              {errors.port?.message && (
                <p className="text-xs text-destructive">{errors.port.message}</p>
              )}
            </div>
          </div>
          <div className="grid gap-1">
            <Label htmlFor="username">Username</Label>
            <Input id="username" {...register("username")} placeholder="root" />
            {errors.username?.message && (
              <p className="text-xs text-destructive">{errors.username.message}</p>
            )}
          </div>
          <div className="grid gap-1">
            <Label>Color</Label>
            <div className="grid grid-cols-12 gap-1.5">
              {PALETTE.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() =>
                    setValue("color", c, {
                      shouldValidate: true,
                      shouldDirty: true,
                    })
                  }
                  className={`aspect-square rounded-md border-2 transition-all ${
                    selectedColor.toLowerCase() === c.toLowerCase()
                      ? "border-foreground"
                      : "border-transparent"
                  }`}
                  style={{ backgroundColor: c }}
                  aria-label={`Pick color ${c}`}
                />
              ))}
            </div>
            <div className="flex items-center gap-1.5">
              <Input
                {...register("color")}
                placeholder="#3b82f6"
                className="font-mono text-xs"
              />
              <span
                className="h-7 w-7 shrink-0 rounded-md border-2 border-foreground"
                style={{ backgroundColor: selectedColor }}
                aria-label={`Current color ${selectedColor}`}
              />
            </div>
            {errors.color?.message && (
              <p className="text-xs text-destructive">{errors.color.message}</p>
            )}
          </div>
          <div className="grid gap-1">
            <Label htmlFor="linux_flavor">Linux flavor</Label>
            <Controller
              name="linux_flavor"
              control={control}
              render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger id="linux_flavor">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {FLAVOR_OPTIONS.map((o) => (
                      <SelectItem key={o.value} value={o.value}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
          </div>
          <div className="grid gap-1">
            <Label htmlFor="notes">Notes</Label>
            <Input id="notes" {...register("notes")} placeholder="optional" />
          </div>
        </form>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button type="submit" form="host-form" disabled={isSubmitting}>
            {isEdit ? "Save changes" : "Create host"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
