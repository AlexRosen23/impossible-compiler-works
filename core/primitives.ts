// Drawing primitives and `group`: named-argument signatures with defaults. This table is part of the language
// specification; the checker, the lowering and the reference interpreter all read it.
import { type Value, colorFromHex, point, table } from './values.ts';

export interface PrimParam { name: string; type: string; default?: Value; nonNegative?: boolean }
export interface PrimSig { params: PrimParam[]; doc: string }

const CREAM = colorFromHex('#f0eadd');

export const PRIMITIVES: Record<string, PrimSig> = table({
  circle: {
    doc: 'circle(x, y, radius: Number, fill?: Color = #f0eadd, stroke?: Color, strokeWidth?: Number = 1)',
    params: [
      { name: 'x', type: 'Number' }, { name: 'y', type: 'Number' }, { name: 'radius', type: 'Number', nonNegative: true },
      { name: 'fill', type: 'Color', default: CREAM }, { name: 'stroke', type: 'Color', default: null },
      { name: 'strokeWidth', type: 'Number', default: 1, nonNegative: true },
    ],
  },
  rect: {
    doc: 'rect(x, y, width, height: Number, fill?: Color = #f0eadd, stroke?: Color, strokeWidth?: Number = 1, corner?: Number = 0)',
    params: [
      { name: 'x', type: 'Number' }, { name: 'y', type: 'Number' },
      { name: 'width', type: 'Number', nonNegative: true }, { name: 'height', type: 'Number', nonNegative: true },
      { name: 'fill', type: 'Color', default: CREAM }, { name: 'stroke', type: 'Color', default: null },
      { name: 'strokeWidth', type: 'Number', default: 1, nonNegative: true }, { name: 'corner', type: 'Number', default: 0, nonNegative: true },
    ],
  },
  line: {
    doc: 'line(from: Point, to: Point, stroke?: Color = #f0eadd, strokeWidth?: Number = 1)',
    params: [
      { name: 'from', type: 'Point' }, { name: 'to', type: 'Point' },
      { name: 'stroke', type: 'Color', default: CREAM }, { name: 'strokeWidth', type: 'Number', default: 1, nonNegative: true },
    ],
  },
  path: {
    doc: 'path(points: List<Point>, fill?: Color, stroke?: Color = #f0eadd, strokeWidth?: Number = 1, closed?: Boolean = false)',
    params: [
      { name: 'points', type: 'List<Point>' }, { name: 'fill', type: 'Color', default: null },
      { name: 'stroke', type: 'Color', default: CREAM }, { name: 'strokeWidth', type: 'Number', default: 1, nonNegative: true },
      { name: 'closed', type: 'Boolean', default: false },
    ],
  },
  text: {
    doc: 'text(x, y: Number, value: String, size?: Number = 14, fill?: Color = #f0eadd)',
    params: [
      { name: 'x', type: 'Number' }, { name: 'y', type: 'Number' }, { name: 'value', type: 'String' },
      { name: 'size', type: 'Number', default: 14, nonNegative: true }, { name: 'fill', type: 'Color', default: CREAM },
    ],
  },
});

export const GROUP_SIG: PrimSig = {
  doc: 'group(translate?: Point = point(0, 0), rotate?: Number = 0 (degrees), scale?: Number = 1, opacity?: Number = 1) { … }',
  params: [
    { name: 'translate', type: 'Point', default: point(0, 0) }, { name: 'rotate', type: 'Number', default: 0 },
    { name: 'scale', type: 'Number', default: 1 }, { name: 'opacity', type: 'Number', default: 1 },
  ],
};

export const PRIMITIVE_KINDS = Object.keys(PRIMITIVES);
