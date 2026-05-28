import type { MdcmsInlineStyle } from "@mdcms/shared";
import { createElement, type CSSProperties, type ReactNode } from "react";

export type BoxProps = {
  style?: MdcmsInlineStyle;
  children?: ReactNode;
};

export function Box({ style, children }: BoxProps) {
  return createElement(
    "div",
    { style: style as CSSProperties | undefined },
    children,
  );
}

export type TextProps = {
  style?: MdcmsInlineStyle;
  children?: ReactNode;
};

export function Text({ style, children }: TextProps) {
  return createElement(
    "span",
    { style: style as CSSProperties | undefined },
    children,
  );
}

export type ImageProps = {
  src: string;
  alt: string;
  style?: MdcmsInlineStyle;
};

export function Image({ src, alt, style }: ImageProps) {
  return createElement("img", {
    src,
    alt,
    style: style as CSSProperties | undefined,
  });
}

export type LinkProps = {
  href: string;
  style?: MdcmsInlineStyle;
  children?: ReactNode;
};

export function Link({ href, style, children }: LinkProps) {
  return createElement(
    "a",
    { href, style: style as CSSProperties | undefined },
    children,
  );
}
