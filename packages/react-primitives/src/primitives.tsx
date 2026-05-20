import type { MdcmsInlineStyle } from "@mdcms/shared";
import type { CSSProperties, ReactNode } from "react";

export type BoxProps = {
  style?: MdcmsInlineStyle;
  children?: ReactNode;
};

export function Box({ style, children }: BoxProps) {
  return <div style={style as CSSProperties | undefined}>{children}</div>;
}

export type TextProps = {
  style?: MdcmsInlineStyle;
  children?: ReactNode;
};

export function Text({ style, children }: TextProps) {
  return <span style={style as CSSProperties | undefined}>{children}</span>;
}

export type ImageProps = {
  src: string;
  alt: string;
  style?: MdcmsInlineStyle;
};

export function Image({ src, alt, style }: ImageProps) {
  return <img src={src} alt={alt} style={style as CSSProperties | undefined} />;
}

export type LinkProps = {
  href: string;
  style?: MdcmsInlineStyle;
  children?: ReactNode;
};

export function Link({ href, style, children }: LinkProps) {
  return (
    <a href={href} style={style as CSSProperties | undefined}>
      {children}
    </a>
  );
}
