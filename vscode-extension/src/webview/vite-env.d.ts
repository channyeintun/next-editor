declare module "*?worker&inline" {
  const factory: new () => Worker;
  export default factory;
}

declare module "*.css" {}
