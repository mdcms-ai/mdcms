import assert from "node:assert/strict";
import { test } from "node:test";

import { isValidElement, type ReactElement } from "react";

import { Box, Image, Link, Text } from "@mdcms/sdk/react-primitives";
import type {
  BoxProps,
  ImageProps,
  LinkProps,
  TextProps,
} from "@mdcms/sdk/react-primitives";

test("react-primitives public subpath exports built-in components and prop types", () => {
  const _boxProps: BoxProps = { style: { padding: 8 } };
  const _textProps: TextProps = { style: { color: "red" } };
  const _imageProps: ImageProps = { src: "/hero.png", alt: "Hero" };
  const _linkProps: LinkProps = { href: "/about" };

  const box = Box(_boxProps) as ReactElement<{
    style?: BoxProps["style"];
  }>;
  const text = Text(_textProps) as ReactElement<{
    style?: TextProps["style"];
  }>;
  const image = Image(_imageProps) as ReactElement<ImageProps>;
  const link = Link(_linkProps) as ReactElement<LinkProps>;

  assert.equal(isValidElement(box), true);
  assert.equal(box.type, "div");
  assert.deepEqual(box.props.style, { padding: 8 });
  assert.equal(isValidElement(text), true);
  assert.equal(text.type, "span");
  assert.deepEqual(text.props.style, { color: "red" });
  assert.equal(isValidElement(image), true);
  assert.equal(image.type, "img");
  assert.equal(image.props.src, "/hero.png");
  assert.equal(image.props.alt, "Hero");
  assert.equal(isValidElement(link), true);
  assert.equal(link.type, "a");
  assert.equal(link.props.href, "/about");
});
