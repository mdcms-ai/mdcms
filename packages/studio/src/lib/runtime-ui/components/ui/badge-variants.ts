import { cva } from "class-variance-authority";

export const badgeVariants = cva(
  "inline-flex items-center justify-center rounded-md border border-transparent px-2 py-0.5 text-xs font-medium w-fit whitespace-nowrap shrink-0 [&>svg]:size-3 gap-1 [&>svg]:pointer-events-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive transition-[color,box-shadow] overflow-hidden",
  {
    variants: {
      variant: {
        default: "bg-muted text-foreground",
        white: "bg-card text-foreground",
        grey: "bg-neutral-grey text-foreground",
        "light-blue": "bg-light-blue text-primary",
        destructive: "bg-destructive/10 text-destructive",
        outline: "border-border text-foreground [a&]:hover:bg-muted",
        tag: "text-tag rounded-pill gap-1.5 px-2.5 py-0.5",
        "tag-accent":
          "text-tag-2 bg-vibrant-green text-foreground rounded-sm px-3 py-1",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);
