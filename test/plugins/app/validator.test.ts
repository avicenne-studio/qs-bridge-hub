import { test, TestContext } from "node:test";
import { Type } from "@sinclair/typebox";
import { build } from "../../helpers/build.js";
import {
  formatFirstError,
  kValidation,
  ValidationService,
} from "../../../src/plugins/app/common/validator.js";

test("validation service validates and asserts schema", async (t: TestContext) => {
  const app = await build(t);
  const validation = app.getDecorator<ValidationService>(kValidation);

  const UserSchema = Type.Object({
    name: Type.String({ minLength: 1 }),
  });

  const valid = { name: "Ada" };
  const invalid = { name: "" };

  t.assert.strictEqual(validation.isValid(UserSchema, valid), true);
  t.assert.strictEqual(validation.isValid(UserSchema, invalid), false);

  t.assert.throws(
    () => validation.assertValid(UserSchema, invalid, "USER"),
    /USER: invalid schema -/
  );

  t.assert.match(
    formatFirstError(UserSchema, invalid),
    /at \/name$/
  );
  t.assert.strictEqual(formatFirstError(UserSchema, valid), "Invalid schema");
});
