(module
 (type $0 (func (param i32 i32 i32 i32) (result i32)))
 (memory $0 0)
 (export "findCommonPrefix" (func $src/core/assembly/index/findCommonPrefix))
 (export "findCommonSuffix" (func $src/core/assembly/index/findCommonSuffix))
 (export "memory" (memory $0))
 (func $src/core/assembly/index/findCommonPrefix (param $0 i32) (param $1 i32) (param $2 i32) (param $3 i32) (result i32)
  (local $4 i32)
  local.get $1
  local.get $3
  local.get $1
  local.get $3
  i32.lt_s
  select
  local.set $3
  loop $while-continue|0
   local.get $4
   i32.const 8
   i32.add
   local.tee $1
   local.get $3
   i32.le_s
   if
    local.get $0
    local.get $4
    i32.add
    i64.load
    local.get $2
    local.get $4
    i32.add
    i64.load
    i64.eq
    if
     local.get $1
     local.set $4
     br $while-continue|0
    end
   end
  end
  loop $while-continue|1
   local.get $3
   local.get $4
   i32.gt_s
   if (result i32)
    local.get $0
    local.get $4
    i32.add
    i32.load8_u
    local.get $2
    local.get $4
    i32.add
    i32.load8_u
    i32.eq
   else
    i32.const 0
   end
   if
    local.get $4
    i32.const 1
    i32.add
    local.set $4
    br $while-continue|1
   end
  end
  local.get $4
 )
 (func $src/core/assembly/index/findCommonSuffix (param $0 i32) (param $1 i32) (param $2 i32) (param $3 i32) (result i32)
  (local $4 i32)
  (local $5 i32)
  local.get $1
  local.get $3
  local.get $1
  local.get $3
  i32.lt_s
  select
  local.set $5
  loop $while-continue|0
   local.get $4
   local.get $5
   i32.lt_s
   if (result i32)
    local.get $0
    local.get $1
    i32.add
    i32.const 1
    i32.sub
    local.get $4
    i32.sub
    i32.load8_u
    local.get $2
    local.get $3
    i32.add
    i32.const 1
    i32.sub
    local.get $4
    i32.sub
    i32.load8_u
    i32.eq
   else
    i32.const 0
   end
   if
    local.get $4
    i32.const 1
    i32.add
    local.set $4
    br $while-continue|0
   end
  end
  local.get $4
 )
)
