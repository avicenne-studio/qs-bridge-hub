import { Type } from '@sinclair/typebox'

export const StringSchema = Type.String({
  minLength: 1,
  maxLength: 255
})

export const DateTimeSchema = Type.String({ format: 'date-time' })

export const IdSchema = Type.String({
  pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
})

export const AmountSchema = Type.String({
  minLength: 1,
  maxLength: 78,
  pattern: '^[0-9]+$'
})

export const SolanaAddressSchema = Type.String({
  minLength: 32,
  maxLength: 44,
  pattern: '^[1-9A-HJ-NP-Za-km-z]+$',
})
