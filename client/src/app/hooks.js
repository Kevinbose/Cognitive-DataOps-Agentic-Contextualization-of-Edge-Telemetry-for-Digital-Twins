/**
 * @file Typed Redux hooks.
 *
 * Thin re-exports today, but every component imports these rather than
 * `react-redux` directly — so when the codebase moves to TypeScript, the
 * `RootState` / `AppDispatch` generics get applied in this one file instead of
 * across every component.
 *
 * @module app/hooks
 */

import { useDispatch, useSelector } from 'react-redux';

/**
 * Typed `useDispatch`.
 * @returns {import('@reduxjs/toolkit').Dispatch} The store dispatch function.
 */
export const useAppDispatch = () => useDispatch();

/**
 * Typed `useSelector`.
 * @type {typeof useSelector}
 */
export const useAppSelector = useSelector;
