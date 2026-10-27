declare module "*.embed" {
  const path: string;
  export default path;
}

declare module "*.sql" {
  const sql: string;
  export default sql;
}

declare module "*.so" {
  const path: string;
  export default path;
}

declare module "*.dylib" {
  const path: string;
  export default path;
}
