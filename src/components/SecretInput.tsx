import {
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
  type Ref,
  type RefObject,
} from "react";
import { EyeIcon, EyeOffIcon } from "lucide-react";

import { Input } from "@/components/ui/input";
import { charRuns, type CharClass } from "@/lib/charClass";
import { cn } from "@/lib/utils";

/** The usual password-manager colours: letters stay the text colour, digits
 * go blue, symbols red. Spaces are left alone. */
const CLASS_COLOUR: Record<CharClass, string | undefined> = {
  letter: undefined,
  digit: "text-blue-600 dark:text-blue-400",
  symbol: "text-red-600 dark:text-red-400",
  space: undefined,
};

/** A secret written out with its digits and symbols coloured. */
export function CharClassText({ text }: { text: string }) {
  return charRuns(text).map((run, i) => (
    <span key={i} className={CLASS_COLOUR[run.cls]}>
      {run.text}
    </span>
  ));
}

function assignRef<T>(ref: Ref<T> | undefined, value: T | null) {
  if (typeof ref === "function") ref(value);
  else if (ref) (ref as RefObject<T | null>).current = value;
}

type CharClassInputProps = ComponentProps<"input"> & {
  /** Colour the characters. Off, this is a plain Input. */
  coloured: boolean;
  /** What the field holds, for the colouring. Defaults to `value`; an
   * uncontrolled field (react-hook-form's `register`) passes its watched
   * value, since there is no `value` prop to read. */
  text?: string;
  /** Classes for the box around the input, for widths (`max-w-xs`). */
  wrapperClassName?: string;
  /** Something sitting over the right end of the field (the eye button). The
   * field keeps room for it. */
  adornment?: ReactNode;
};

/**
 * An Input whose text can be shown coloured by character class. An input can
 * only paint its text one colour, so the input's own text goes transparent
 * (the caret and selection stay) and a copy in coloured spans sits over it in
 * the same font and padding, shifted by the input's scroll so a long value
 * lines up when the field scrolls. Monospace while coloured, which on its own
 * already separates `l`, `1` and `I`.
 */
export function CharClassInput({
  coloured,
  text,
  wrapperClassName,
  adornment,
  className,
  value,
  ref,
  onScroll,
  onSelect,
  ...props
}: CharClassInputProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [scrollX, setScrollX] = useState(0);
  const content = text ?? (typeof value === "string" ? value : "");

  const syncScroll = () => setScrollX(inputRef.current?.scrollLeft ?? 0);

  return (
    <div className={cn("relative", wrapperClassName)}>
      <Input
        {...props}
        ref={(el) => {
          inputRef.current = el;
          assignRef(ref, el);
        }}
        value={value}
        onScroll={(e) => {
          syncScroll();
          onScroll?.(e);
        }}
        onSelect={(e) => {
          syncScroll();
          onSelect?.(e);
        }}
        className={cn(
          "peer",
          adornment && "pr-9",
          coloured &&
            "font-mono text-transparent caret-foreground selection:text-transparent",
          className,
        )}
      />
      {coloured && (
        <div
          aria-hidden
          className={cn(
            "pointer-events-none absolute inset-0 border border-transparent py-1 pl-2.5 font-mono text-base text-foreground peer-disabled:opacity-50 md:text-sm",
            adornment ? "pr-9" : "pr-2.5",
          )}
        >
          <div className="flex h-full items-center overflow-hidden">
            <span
              className="shrink-0 whitespace-pre"
              style={{ transform: `translateX(${-scrollX}px)` }}
            >
              <CharClassText text={content} />
            </span>
          </div>
        </div>
      )}
      {adornment}
    </div>
  );
}

type SecretInputProps = Omit<
  CharClassInputProps,
  "type" | "coloured" | "adornment"
> & {
  /** Names the secret in the eye button's label ("Show passphrase"). */
  noun: string;
  /** Shown or masked, for a parent that needs to reset it; kept here
   * otherwise. Masked by default. */
  shown?: boolean;
  onShownChange?: (shown: boolean) => void;
};

/** A password box with an eye to show it. Shown, its digits and symbols are
 * coloured; masked, nothing is, since coloured dots would tell anyone looking
 * over a shoulder which characters are numbers. */
export function SecretInput({
  noun,
  shown,
  onShownChange,
  ...props
}: SecretInputProps) {
  const [ownShown, setOwnShown] = useState(false);
  const isShown = shown ?? ownShown;
  const toggle = () => {
    setOwnShown(!isShown);
    onShownChange?.(!isShown);
  };

  return (
    <CharClassInput
      {...props}
      type={isShown ? "text" : "password"}
      coloured={isShown}
      spellCheck={false}
      adornment={
        <button
          type="button"
          onClick={toggle}
          // Keep the keyboard in the field, so you can show it and go on typing.
          onMouseDown={(e) => e.preventDefault()}
          className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
          tabIndex={-1}
          aria-label={isShown ? `Hide ${noun}` : `Show ${noun}`}
        >
          {isShown ? (
            <EyeOffIcon className="h-4 w-4" />
          ) : (
            <EyeIcon className="h-4 w-4" />
          )}
        </button>
      }
    />
  );
}
