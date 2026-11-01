import * as React from "react";
import { Input as InputPrimitive } from "@base-ui/react/input";

function Input(props: React.ComponentProps<"input">) {
  return <InputPrimitive data-slot="input" {...props} />;
}

export { Input };
