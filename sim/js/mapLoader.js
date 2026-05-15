export async function loadImageFromFile(file) {
  const url = URL.createObjectURL(file);
  const image = await loadImageFromUrl(url);
  URL.revokeObjectURL(url);
  return image;
}

export function loadImageFromUrl(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
}
