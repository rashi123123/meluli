import { Button as ButtonPrimitive } from "@base-ui/react/button";

type ButtonVariant = "default" | "secondary" | "ghost" | "destructive" | "link" | "plain";
type ButtonSize = "default" | "sm" | "lg" | "icon" | "icon-xs" | "icon-sm" | "icon-lg";

// Appearance lives in instrument.css, keyed on data-variant and data-size.
function Button({ variant = "default", size = "default", ...props }: ButtonPrimitive.Props & { variant?: ButtonVariant; size?: ButtonSize }) {
  return <ButtonPrimitive data-slot="button" data-variant={variant} data-size={size} {...props} />;
}

export { Button };
