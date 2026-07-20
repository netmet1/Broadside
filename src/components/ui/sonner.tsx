"use client"

import { useTheme } from "next-themes"
import { Toaster as Sonner, type ToasterProps } from "sonner"
import { CircleCheckIcon, InfoIcon, TriangleAlertIcon, OctagonXIcon, Loader2Icon } from "lucide-react"

const Toaster = ({ ...props }: ToasterProps) => {
  const { theme = "system" } = useTheme()

  return (
    <Sonner
      theme={theme as ToasterProps["theme"]}
      className="toaster group"
      icons={{
        success: (
          <CircleCheckIcon className="size-4" />
        ),
        info: (
          <InfoIcon className="size-4" />
        ),
        warning: (
          <TriangleAlertIcon className="size-4" />
        ),
        error: (
          <OctagonXIcon className="size-4" />
        ),
        loading: (
          <Loader2Icon className="size-4 animate-spin" />
        ),
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius)",
        } as React.CSSProperties
      }
      // Colour the text by outcome, so a toast reads at a glance without being
      // parsed: red went wrong, green worked, amber is a caveat, and anything
      // that is just telling you something stays the plain popover colour. The
      // icons inherit it, since they are drawn with currentColor.
      toastOptions={{
        classNames: {
          toast: "cn-toast",
          error: "text-red-600! dark:text-red-400!",
          success: "text-emerald-600! dark:text-emerald-400!",
          warning: "text-amber-600! dark:text-amber-400!",
        },
      }}
      {...props}
    />
  )
}

export { Toaster }
