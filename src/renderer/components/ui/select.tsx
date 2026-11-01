import * as React from "react";
import { CaretDown } from "@/components/icons";

function Select({ children, ...props }: React.ComponentProps<"select">) {
  return <span className="select-field">
    <select data-slot="select" {...props}>{children}</select>
    <CaretDown />
  </span>;
}

export { Select };
