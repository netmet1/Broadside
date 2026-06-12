import { useEffect, useState } from "react";
import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";
import { EyeIcon, EyeOffIcon, FolderOpenIcon } from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  type AuthInput,
  type Host,
  type HostInput,
  clearHostCredentials,
  createHost,
  errorMessage,
  pathIsFile,
  setHostCredentials,
  setSudoPassword,
  setSudoSameAsLogin,
  updateHost,
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

/** Expand #abc → #aabbcc for the native color input (it requires 6 digits). */
function expandHex(c: string): string {
  const short = /^#([0-9a-fA-F]{3})$/.exec(c);
  if (short) {
    return (
      "#" +
      short[1]
        .split("")
        .map((ch) => ch + ch)
        .join("")
    );
  }
  return /^#[0-9a-fA-F]{6}$/.test(c) ? c : "#3b82f6";
}

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
  authMethod: z.enum(["none", "password", "key"]),
  password: z.string(),
  keyPath: z.string(),
  keyPassphrase: z.string(),
  sudoPassword: z.string(),
  sudoSameAsLogin: z.boolean(),
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
    authMethod: "none",
    password: "",
    keyPath: "",
    keyPassphrase: "",
    sudoPassword: "",
    sudoSameAsLogin: false,
  };
}

type Props = {
  host: Host | null;
  defaultColor: string;
  onCancel: () => void;
  onSaved: () => void;
};

export function HostFormPanel({ host, defaultColor, onCancel, onSaved }: Props) {
  const isEdit = host !== null;
  const [editingCredentials, setEditingCredentials] = useState(!isEdit);
  const [showPassword, setShowPassword] = useState(false);
  const [showKeyPassphrase, setShowKeyPassphrase] = useState(false);
  const [showSudoPassword, setShowSudoPassword] = useState(false);
  /** Only meaningful when the host already has a sudo password stored. */
  const [sudoAction, setSudoAction] = useState<"keep" | "replace" | "remove">(
    "keep",
  );

  const {
    register,
    handleSubmit,
    control,
    reset,
    watch,
    setValue,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: emptyValues(defaultColor),
  });

  // Reset form whenever the host being edited changes (or we open in add mode).
  useEffect(() => {
    setEditingCredentials(!host);
    setShowPassword(false);
    setShowKeyPassphrase(false);
    setShowSudoPassword(false);
    setSudoAction("keep");
    if (host) {
      reset({
        label: host.label,
        hostname: host.hostname,
        port: host.port,
        username: host.username,
        color: host.color,
        linux_flavor: host.linux_flavor ?? "__none__",
        notes: host.notes ?? "",
        authMethod:
          (host.auth_method as "password" | "key" | null) ?? "none",
        password: "",
        keyPath: host.key_path ?? "",
        keyPassphrase: "",
        sudoPassword: "",
        sudoSameAsLogin: false,
      });
    } else {
      reset(emptyValues(defaultColor));
    }
  }, [host, defaultColor, reset]);

  // Signal AppShell to blur the sidebar while this panel is mounted.
  useEffect(() => {
    document.documentElement.dataset.formOverlay = "true";
    return () => {
      delete document.documentElement.dataset.formOverlay;
    };
  }, []);

  // Escape cancels the form (unless we're mid-submit).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !isSubmitting) {
        e.preventDefault();
        onCancel();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isSubmitting, onCancel]);

  const selectedColor = watch("color");
  const authMethod = watch("authMethod");
  const sudoSameAsLogin = watch("sudoSameAsLogin");

  const hasSudo = host?.has_sudo_password ?? false;
  // Whether the effective auth method is password (so "same as SSH
  // password" makes sense): the value being edited, or the stored one.
  const passwordAuthEffective = editingCredentials
    ? authMethod === "password"
    : host?.auth_method === "password";
  const sudoEditing = !hasSudo || sudoAction === "replace";

  const onSubmit = handleSubmit(async (data) => {
    if (editingCredentials) {
      if (data.authMethod === "password" && data.password.length === 0) {
        toast.error("Password is required");
        return;
      }
      if (data.authMethod === "key") {
        const keyPath = data.keyPath.trim();
        if (keyPath.length === 0) {
          toast.error("Key file path is required");
          return;
        }
        // Catch hand-typed paths that don't exist (Browse always yields a
        // real file) before they're stored and fail at connect time.
        if (!(await pathIsFile(keyPath))) {
          setError("keyPath", {
            message: "File not found — check the path or use Browse",
          });
          return;
        }
      }
    }
    if (
      hasSudo &&
      sudoAction === "replace" &&
      !data.sudoSameAsLogin &&
      data.sudoPassword.length === 0
    ) {
      toast.error("Sudo password is required (or choose Keep existing)");
      return;
    }

    const input: HostInput = {
      label: data.label.trim(),
      hostname: data.hostname.trim(),
      port: data.port,
      username: data.username.trim(),
      color: data.color,
      linux_flavor:
        data.linux_flavor === "__none__" ? null : data.linux_flavor,
      notes: data.notes.trim() === "" ? null : data.notes.trim(),
    };

    try {
      const saved = host
        ? await updateHost(host.id, input)
        : await createHost(input);

      if (editingCredentials) {
        if (data.authMethod === "none") {
          if (host?.auth_method) {
            await clearHostCredentials(saved.id);
          }
        } else if (data.authMethod === "password") {
          const auth: AuthInput = { kind: "password", value: data.password };
          await setHostCredentials(saved.id, auth);
        } else if (data.authMethod === "key") {
          const auth: AuthInput = {
            kind: "key",
            path: data.keyPath.trim(),
            passphrase:
              data.keyPassphrase.length === 0 ? null : data.keyPassphrase,
          };
          await setHostCredentials(saved.id, auth);
        }
      }

      if (hasSudo && sudoAction === "remove") {
        await setSudoPassword(saved.id, null);
      } else if (sudoEditing) {
        if (data.sudoSameAsLogin && passwordAuthEffective) {
          await setSudoSameAsLogin(saved.id);
        } else if (data.sudoPassword.length > 0) {
          await setSudoPassword(saved.id, data.sudoPassword);
        }
      }

      toast.success(host ? `Updated ${input.label}` : `Created ${input.label}`);
      onSaved();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  });

  const handleBrowseKey = async () => {
    try {
      const result = await openDialog({
        multiple: false,
        directory: false,
        title: "Select SSH private key file",
      });
      if (typeof result === "string") {
        setValue("keyPath", result, { shouldValidate: true, shouldDirty: true });
      }
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const credSummary =
    host?.auth_method === "password"
      ? "Password is stored"
      : host?.auth_method === "key"
        ? `Key: ${host.key_path ?? "(no path)"}`
        : "No credentials set";

  return (
    <section className="flex h-full flex-col bg-background">
      <header className="px-8 py-5">
        <h1 className="font-heading text-xl font-semibold tracking-tight">
          {isEdit ? "Edit host" : "Add host"}
        </h1>
        <p className="text-sm text-muted-foreground">
          {isEdit
            ? "Modify the connection details."
            : "Define a new SSH connection target."}
        </p>
      </header>

      <form
        id="host-form"
        onSubmit={onSubmit}
        className="flex-1 overflow-auto px-8 py-6"
      >
        <div className="grid max-w-4xl grid-cols-1 gap-x-8 gap-y-4 md:grid-cols-2">
          <div className="grid gap-1">
            <Label htmlFor="label">Label</Label>
            <Input id="label" {...register("label")} placeholder="web-01" autoFocus />
            <p className="min-h-4 text-xs text-destructive">
              {errors.label?.message ?? ""}
            </p>
          </div>

          <div className="grid gap-1">
            <Label htmlFor="username">Username</Label>
            <Input id="username" {...register("username")} placeholder="root" />
            <p className="min-h-4 text-xs text-destructive">
              {errors.username?.message ?? ""}
            </p>
          </div>

          <div className="grid grid-cols-[1fr_auto] gap-2">
            <div className="grid gap-1">
              <Label htmlFor="hostname">Hostname</Label>
              <Input
                id="hostname"
                {...register("hostname")}
                placeholder="web01.example.com"
              />
              <p className="min-h-4 text-xs text-destructive">
                {errors.hostname?.message ?? ""}
              </p>
            </div>
            <div className="grid gap-1">
              <Label htmlFor="port">Port</Label>
              <Input
                id="port"
                type="number"
                className="w-24"
                {...register("port", { valueAsNumber: true })}
              />
              <p className="min-h-4 text-xs text-destructive">
                {errors.port?.message ?? ""}
              </p>
            </div>
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
            <p className="min-h-4 text-xs" aria-hidden="true">&nbsp;</p>
          </div>

          <div className="grid gap-1 md:col-span-2">
            <Label>Color</Label>
            <div className="grid max-w-md grid-cols-12 gap-1.5">
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
            <div className="flex max-w-md items-center gap-1.5">
              <Input
                {...register("color")}
                placeholder="#3b82f6"
                className="font-mono text-xs"
              />
              {/* Live preview doubles as a button: clicking it opens the
                  native color picker. */}
              <span className="relative h-7 w-7 shrink-0">
                <span
                  className="block h-full w-full rounded-md border-2 border-foreground"
                  style={{ backgroundColor: selectedColor }}
                  aria-hidden="true"
                />
                <input
                  type="color"
                  value={expandHex(selectedColor)}
                  onChange={(e) =>
                    setValue("color", e.target.value, {
                      shouldValidate: true,
                      shouldDirty: true,
                    })
                  }
                  className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                  aria-label={`Current color ${selectedColor} — click to open the color picker`}
                  title="Pick a color"
                />
              </span>
            </div>
            <p className="min-h-4 text-xs text-destructive">
              {errors.color?.message ?? ""}
            </p>
          </div>

          <div className="grid gap-1 md:col-span-2">
            <Label htmlFor="notes">Notes</Label>
            <Input id="notes" {...register("notes")} placeholder="optional" />
            <p className="min-h-4 text-xs" aria-hidden="true">&nbsp;</p>
          </div>
        </div>

        <div className="mt-8 max-w-4xl pt-5">
          <div className="mb-3 flex items-center justify-between">
            <Label className="text-sm font-semibold">Credentials</Label>
            {isEdit && !editingCredentials && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setEditingCredentials(true)}
              >
                Replace credentials...
              </Button>
            )}
            {isEdit && editingCredentials && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setEditingCredentials(false)}
              >
                Keep existing
              </Button>
            )}
          </div>

          {isEdit && !editingCredentials ? (
            <p
              className={`text-xs ${
                host?.auth_method
                  ? "font-medium text-emerald-400"
                  : "text-muted-foreground"
              }`}
            >
              {credSummary}
            </p>
          ) : (
            <div className="grid gap-4">
              <Controller
                name="authMethod"
                control={control}
                render={({ field }) => (
                  <RadioGroup
                    value={field.value}
                    onValueChange={field.onChange}
                    className="flex gap-6"
                  >
                    <label className="flex cursor-pointer items-center gap-2 text-sm">
                      <RadioGroupItem value="none" id="auth-none" />
                      None
                    </label>
                    <label className="flex cursor-pointer items-center gap-2 text-sm">
                      <RadioGroupItem value="password" id="auth-password" />
                      Password
                    </label>
                    <label className="flex cursor-pointer items-center gap-2 text-sm">
                      <RadioGroupItem value="key" id="auth-key" />
                      Private key
                    </label>
                  </RadioGroup>
                )}
              />

              {authMethod === "password" && (
                <div className="grid max-w-md gap-1">
                  <Label htmlFor="password">Password</Label>
                  <div className="relative">
                    <Input
                      id="password"
                      type={showPassword ? "text" : "password"}
                      {...register("password")}
                      className="pr-9"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword((v) => !v)}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                      tabIndex={-1}
                      aria-label={showPassword ? "Hide password" : "Show password"}
                    >
                      {showPassword ? (
                        <EyeOffIcon className="h-4 w-4" />
                      ) : (
                        <EyeIcon className="h-4 w-4" />
                      )}
                    </button>
                  </div>
                </div>
              )}

              {authMethod === "key" && (
                <div className="grid gap-4 md:grid-cols-2">
                  <div className="grid gap-1">
                    <Label htmlFor="keyPath">Key file</Label>
                    <div className="flex gap-2">
                      <Input
                        id="keyPath"
                        {...register("keyPath")}
                        placeholder="C:\Users\you\.ssh\id_ed25519"
                        className={`font-mono text-xs ${errors.keyPath ? "border-destructive" : ""}`}
                      />
                      <Button
                        type="button"
                        variant="outline"
                        size="default"
                        onClick={handleBrowseKey}
                      >
                        <FolderOpenIcon />
                        Browse
                      </Button>
                    </div>
                    <p className="min-h-4 text-xs text-destructive">
                      {errors.keyPath?.message ?? ""}
                    </p>
                  </div>
                  <div className="grid gap-1">
                    <Label htmlFor="keyPassphrase">
                      Key passphrase{" "}
                      <span className="text-xs text-muted-foreground">
                        (optional)
                      </span>
                    </Label>
                    <div className="relative">
                      <Input
                        id="keyPassphrase"
                        type={showKeyPassphrase ? "text" : "password"}
                        {...register("keyPassphrase")}
                        className="pr-9"
                      />
                      <button
                        type="button"
                        onClick={() => setShowKeyPassphrase((v) => !v)}
                        className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                        tabIndex={-1}
                        aria-label={
                          showKeyPassphrase
                            ? "Hide passphrase"
                            : "Show passphrase"
                        }
                      >
                        {showKeyPassphrase ? (
                          <EyeOffIcon className="h-4 w-4" />
                        ) : (
                          <EyeIcon className="h-4 w-4" />
                        )}
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="mt-8 max-w-4xl pt-5">
          <div className="mb-3 flex items-center justify-between">
            <Label className="text-sm font-semibold">
              Sudo password{" "}
              <span className="text-xs font-normal text-muted-foreground">
                (optional — used to auto-answer sudo prompts in broadcasts)
              </span>
            </Label>
            {hasSudo && sudoAction === "keep" && (
              <div className="flex gap-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setSudoAction("replace")}
                >
                  Replace sudo password...
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="text-destructive hover:text-destructive"
                  onClick={() => setSudoAction("remove")}
                >
                  Remove
                </Button>
              </div>
            )}
            {hasSudo && sudoAction !== "keep" && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setSudoAction("keep")}
              >
                Keep existing
              </Button>
            )}
          </div>

          {hasSudo && sudoAction === "keep" && (
            <p className="text-xs font-medium text-emerald-400">
              Sudo password is stored
            </p>
          )}
          {hasSudo && sudoAction === "remove" && (
            <p className="text-xs font-medium text-amber-400">
              Sudo password will be removed on save
            </p>
          )}
          {sudoEditing && (
            <div className="grid max-w-md gap-2">
              <div className="relative">
                <Input
                  id="sudoPassword"
                  type={showSudoPassword ? "text" : "password"}
                  {...register("sudoPassword")}
                  disabled={sudoSameAsLogin && passwordAuthEffective}
                  className="pr-9"
                />
                <button
                  type="button"
                  onClick={() => setShowSudoPassword((v) => !v)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  tabIndex={-1}
                  aria-label={
                    showSudoPassword
                      ? "Hide sudo password"
                      : "Show sudo password"
                  }
                >
                  {showSudoPassword ? (
                    <EyeOffIcon className="h-4 w-4" />
                  ) : (
                    <EyeIcon className="h-4 w-4" />
                  )}
                </button>
              </div>
              {passwordAuthEffective && (
                <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
                  <input
                    type="checkbox"
                    className="accent-primary"
                    {...register("sudoSameAsLogin")}
                  />
                  Same as SSH password
                </label>
              )}
            </div>
          )}
        </div>
      </form>

      <footer className="flex justify-end gap-2 px-8 py-4">
        <Button
          type="button"
          variant="outline"
          onClick={onCancel}
          disabled={isSubmitting}
        >
          Cancel
        </Button>
        <Button type="submit" form="host-form" disabled={isSubmitting}>
          {isEdit ? "Save changes" : "Create host"}
        </Button>
      </footer>
    </section>
  );
}
