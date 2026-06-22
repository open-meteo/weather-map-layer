export const pad = (n: string | number) => {
	return ('0' + n).slice(-2);
};

export const capitalize = (s: string) => {
	return String(s[0]).toUpperCase() + String(s).slice(1);
};
