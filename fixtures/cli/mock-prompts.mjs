const cancelled = Symbol.for("shadcn-plus-test-cancel");
export const isCancel = (value) => value === cancelled;
export const intro = () => {};
export const note = () => {};
export const outro = (message) => console.log(message);
export const cancel = outro;
export const log = { step() {}, info() {}, warn() {}, error() {}, success() {} };
export const spinner = () => ({ start() {}, stop() {} });
export const confirm = async () => process.env.SHADCN_PLUS_CANCEL
  ? cancelled : !process.env.SHADCN_PLUS_DECLINE;
export const text = async () => process.env.SHADCN_PLUS_CANCEL_TEXT ? cancelled : "Test preset";
export const select = async ({ options }) => options[0]?.value;
export const multiselect = async ({ options, required, initialValues }) => required === false
  ? process.env.SHADCN_PLUS_SELECT_DEPS ? options.map((option) => option.value) : []
  : initialValues?.length ? initialValues : options.slice(0, 1).map((option) => option.value);
