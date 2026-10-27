declare module "*.embed" {
  const path: string;
  export default path;
}

declare module "*.sql" {
  const sql: string;
  export default sql;
}
