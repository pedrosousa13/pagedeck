import { expect, test } from "vitest";
import { child, children, readXml, text, writeXml } from "./distribution-xml.js";

const DOCUMENT = `<?xml version="1.0" encoding="UTF-8"?>
<DistributionConfig xmlns="http://cloudfront.amazonaws.com/doc/2020-05-31/">
  <CallerReference>ref-1</CallerReference>
  <Comment>Tom &amp; Jerry &lt;3 &#x41;&#66;</Comment>
  <DefaultRootObject></DefaultRootObject>
  <Origins>
    <Quantity>1</Quantity>
    <Items>
      <Origin><Id>site</Id><DomainName>bucket.example</DomainName></Origin>
    </Items>
  </Origins>
</DistributionConfig>
`;

test("reads elements, text, the root's attributes and every entity form", () => {
  const root = readXml(DOCUMENT, "distribution E1");
  expect(root.name).toBe("DistributionConfig");
  expect(root.attributes).toEqual([["xmlns", "http://cloudfront.amazonaws.com/doc/2020-05-31/"]]);
  expect(text(child(root, "Comment"))).toBe("Tom & Jerry <3 AB");
  expect(text(child(root, "DefaultRootObject"))).toBe("");
  const origins = child(child(root, "Origins"), "Items");
  expect(children(origins, "Origin").map((one) => text(child(one, "Id")))).toEqual(["site"]);
});

test("what it writes reads back to the same tree, and writing is stable", () => {
  const once = writeXml(readXml(DOCUMENT, "distribution E1"));
  expect(once.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<DistributionConfig xmlns=')).toBe(true);
  expect(once).toContain("<Comment>Tom &amp; Jerry &lt;3 AB</Comment>");
  expect(writeXml(readXml(once, "again"))).toBe(once);
});

test.each([
  ["a comment", "<A><!-- x --></A>"],
  ["CDATA", "<A><![CDATA[x]]></A>"],
  ["a DOCTYPE", "<!DOCTYPE A><A/>"],
  ["a mismatched close", "<A><B></A></B>"],
  ["text beside elements", "<A>x<B/></A>"],
  ["an unknown entity", "<A>&nbsp;</A>"],
  ["trailing content", "<A/><B/>"],
])("refuses %s, naming where the document came from", (_, xml) => {
  expect(() => readXml(xml, "distribution E1")).toThrow(/distribution E1/);
});
