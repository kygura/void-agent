import { Container, type SelectItem, SelectList, type SelectListLayoutOptions } from "@void/tui";
import { getSelectListTheme } from "../theme/theme.js";
import { DynamicBorder } from "./dynamic-border.js";
import { getSplashPaletteNames, SPLASH_PALETTE_RANDOM } from "./splash.js";

const PALETTE_SELECT_LIST_LAYOUT: SelectListLayoutOptions = {
	minPrimaryColumnWidth: 12,
	maxPrimaryColumnWidth: 32,
};

/**
 * Component that renders a splash palette selector
 */
export class SplashPaletteSelectorComponent extends Container {
	private selectList: SelectList;

	constructor(
		currentPalette: string,
		onSelect: (paletteName: string) => void,
		onCancel: () => void,
		onPreview: (paletteName: string) => void,
	) {
		super();

		const palettes = [SPLASH_PALETTE_RANDOM, ...getSplashPaletteNames()];
		const paletteItems: SelectItem[] = palettes.map((name) => ({
			value: name,
			label: name,
			description: name === currentPalette ? "(current)" : undefined,
		}));

		this.addChild(new DynamicBorder());

		this.selectList = new SelectList(paletteItems, 10, getSelectListTheme(), PALETTE_SELECT_LIST_LAYOUT);

		const currentIndex = palettes.indexOf(currentPalette);
		if (currentIndex !== -1) {
			this.selectList.setSelectedIndex(currentIndex);
		}

		this.selectList.onSelect = (item) => {
			onSelect(item.value);
		};

		this.selectList.onCancel = () => {
			onCancel();
		};

		this.selectList.onSelectionChange = (item) => {
			onPreview(item.value);
		};

		this.addChild(this.selectList);

		this.addChild(new DynamicBorder());
	}

	getSelectList(): SelectList {
		return this.selectList;
	}
}
